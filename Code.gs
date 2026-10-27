/**
 * Dooray! 메일을 감지하여 Gemini API로 일정을 파싱한 후 Google Calendar에 일괄 등록합니다.
 */

function autoSyncDoorayMailToCalendar() {
  // 1. 중복 실행 방지를 위한 Script Lock 설정
  const lock = LockService.getScriptLock();  
  if (!lock.tryLock(1000)) {
    Logger.log('[INFO] 이전 스크립트 실행이 아직 처리 중입니다. 이번 실행은 건너뜁니다.');
    return;
  }

  // 2. 실행 시간 및 배치 크기 설정
  const START_TIME = Date.now();
  const MAX_EXECUTION_TIME_MS = 4.5 * 60 * 1000; // 시간 제한
  const BATCH_SIZE = 3; // 한 번 실행할 때 최대 스레드 처리 개수 제한
  const MAX_OUTPUT_TOKENS = 1000; // API 호출별 JSON 텍스트 길이 제한

  let processedThreadsCount = 0;
  let totalUnreadMessagesCount = 0;
  let registeredEventsCount = 0;
  let nonEventCount = 0;
  let errorCount = 0;
  const createdEventsSummary = [];
  const errorDetailsSummary = [];

  try {
    const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    const doorayMail = PropertiesService.getScriptProperties().getProperty('DOORAY_MAIL');
    const calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');

    if (!apiKey || !doorayMail || !calendarId) {
      Logger.log('[ERROR] 필수 스크립트 속성(GEMINI_API_KEY, DOORAY_MAIL, CALENDAR_ID)이 누락되었습니다.');
      return;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;
    const searchQuery = `is:unread to:(${doorayMail})`;
    
    Logger.log(`[INFO] 검색된 쿼리 확인: ${searchQuery}`);

    const threads = GmailApp.search(searchQuery, 0, BATCH_SIZE);
    const calendar = CalendarApp.getCalendarById(calendarId);

    Logger.log(`[INFO] 이번 회차 처리 대상 메일 스레드 수 : ${threads.length}`);

    const apiRequests = [];
    const mailContexts = [];

    // 3. 읽지 않은 메일을 순회하며 '스레드당 가장 마지막(최신) 안 읽은 메일'만 추출
    for (const thread of threads) {
      // 시간 제한 체크
      if (Date.now() - START_TIME > MAX_EXECUTION_TIME_MS) {
        Logger.log('[WARNING] 실행 시간 제한(4.5분)에 도달하여 작업을 다음 실행으로 미룹니다.');
        break;
      }

      const messages = thread.getMessages();
      
      // 스레드 내의 메시지 중 읽지 않은 메일들만 필터링
      const unreadMessages = messages.filter(msg => msg.isUnread());
      
      if (unreadMessages.length === 0) continue;

      processedThreadsCount++;
      totalUnreadMessagesCount += unreadMessages.length;

      // 배열의 마지막 원소(가장 최신 메일)를 선택
      const latestMsg = unreadMessages[unreadMessages.length - 1];

      const subject = latestMsg.getSubject();
      const body = latestMsg.getPlainBody();
      const mailDate = latestMsg.getDate();
      const todayStr = Utilities.formatDate(mailDate, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");

      Logger.log(`[INFO] API 요청 대기열 추가 (최신 메일) : ${subject}`);

      const prompt = `
당신은 메일 내용에서 행사, 대회, 세미나, 모임, 제출 마감일 등 일정 정보를 추출하고 핵심 내용을 요약하는 AI 도우미입니다.
아래 메일 내용을 분석하여 Google Calendar에 등록할 일정 정보와 상세 설명에 들어갈 요약 내용을 추출해 주세요.

[기준 메일 수신 시간]: ${todayStr}

[메일 제목]: ${subject}
[메일 본문]:
${body.substring(0, 4000)}

[핵심 추출 규칙]:
1. 메일에 특정 날짜나 일시(행사 당일, 세미나 시각, 신청/제출 마감일 등)가 단 하나라도 언급되어 있다면 적극적으로 isEvent를 true로 설정하세요.
2. 시간이 명시되지 않고 날짜만 있는 경우(예: '10월 28일 개최', '10/28 마감'), isAllDay를 true로 설정하고 시작 시간을 해당 날짜 09:00:00으로 작성하세요.
3. 한국어 날짜 표현('10월 28일(수)', '10/28', '내일', '이번주 금요일')은 [기준 메일 수신 시간]을 기준으로 연도와 날짜를 정확히 계산하세요. 연도가 생략되어 있으면 수신 시간의 연도를 적용하세요.
4. summary 필드에는 캘린더 상세 내용에 들어가기 좋도록 메일의 핵심 내용(행사 목적, 주요 안내 사항, 준비물 등)을 3~5줄 내외로 깔끔하게 요약해 주세요.
5. 순수 JSON 객체 이외의 설명이나 마크다운 백틱은 절대 포함하지 마세요.

[JSON 출력 포맷]:
{
  "isEvent": true,
  "title": "행사/대회명 (또는 '[마감] OO 신청')",
  "startDate": "YYYY-MM-DDTHH:mm:ss",
  "endDate": "YYYY-MM-DDTHH:mm:ss 또는 null",
  "isAllDay": true 또는 false,
  "location": "장소 또는 온라인 링크 (없으면 빈 문자열)",
  "summary": "메일 내용의 핵심 요약 내용 (3~5줄)"
}
`;

      const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseMimeType: "application/json"
        }
      };

      apiRequests.push({
        url: url,
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      // 스레드 전체와 파싱에 사용한 최신 메시지(latestMsg)를 컨텍스트에 저장
      mailContexts.push({ thread, msg: latestMsg, subject, body });
    }

    // 4. 수집된 API 요청을 병렬로 한 번에 처리
    if (apiRequests.length > 0) {
      Logger.log(`[INFO] 총 ${apiRequests.length}건의 일정을 Gemini API로 병렬 분석 요청합니다.`);
      const responses = UrlFetchApp.fetchAll(apiRequests);

      // 5. API 응답 분석 및 구글 캘린더 등록
      responses.forEach((response, index) => {
        const { thread, msg, subject, body } = mailContexts[index];
        const responseCode = response.getResponseCode();
        const responseText = response.getContentText();

        if (responseCode !== 200) {
          errorCount++;
          try {
            const errorJson = JSON.parse(responseText);
            if (errorJson.error && errorJson.error.message) {
              detailedErrorMessage = errorJson.error.message;
            }
          } catch (e) {
            // responseText가 JSON 형식이 아니면 텍스트 원문 사용
          }

          const errorMsg = `메일 '${subject}' API 처리 실패 (HTTP ${responseCode}: ${detailedErrorMessage}).`;
          Logger.log(`[ERROR] ${errorMsg} 다음 실행 시 재시도합니다.`);
          errorDetailsSummary.push(` - ${errorMsg}`);
          return;
        }

        try {
          const json = JSON.parse(responseText);
          
          if (json.candidates && json.candidates[0].content.parts[0].text) {
            const parsedEvent = JSON.parse(json.candidates[0].content.parts[0].text.trim());

            if (parsedEvent && parsedEvent.isEvent && parsedEvent.startDate) {
              const startTime = new Date(parsedEvent.startDate);
              let endTime = parsedEvent.endDate 
                ? new Date(parsedEvent.endDate) 
                : new Date(startTime.getTime() + 60 * 60 * 1000);

              const descriptionText = parsedEvent.summary 
                ? `[Dooray 메일 연동]\n\n${parsedEvent.summary}` 
                : `[Dooray 메일 연동]\n\n${body}`;

              const titleText = parsedEvent.title || subject;

              if (parsedEvent.isAllDay) {
                calendar.createAllDayEvent(titleText, startTime, {
                  description: descriptionText,
                  location: parsedEvent.location || ''
                });
              } else {
                calendar.createEvent(titleText, startTime, endTime, {
                  description: descriptionText,
                  location: parsedEvent.location || ''
                });
              }

              Logger.log(`[SUCCESS] 일정 등록 완료 : ${titleText} (${parsedEvent.startDate})`);
              registeredEventsCount++;
              createdEventsSummary.push(`  - "${titleText}" (${parsedEvent.startDate})`);
            } else {
              Logger.log(`[INFO] 일정 정보가 없거나 행사 메일이 아님 : ${subject}`);
              nonEventCount++;
            }
          }

          // 파싱 및 처리가 성공적으로 마친 경우 스레드 내 모든 메일을 읽음 처리 후 휴지통 이동
          thread.markRead();
          thread.moveToTrash();
          Logger.log(`[INFO] 스레드 전체 읽음 및 휴지통 이동 완료 : ${subject}`);

        } catch (e) {
          errorCount++;
          const errorMsg = `메일 '${subject}' 파싱 또는 캘린더 등록 실패 : ${e.message}.`;
          Logger.log(`[ERROR] ${errorMsg} 다음 실행 시 재시도합니다.`);
          errorDetailsSummary.push(` - ${errorMsg}`);
        }
      });
    }

    let summaryLog = `\n==================================================\n`;
    summaryLog += `[INFO] Dooray 메일 캘린더 동기화 실행 결과 요약\n`;
    summaryLog += `==================================================\n`;
    summaryLog += `- 총 처리 스레드 수: ${processedThreadsCount}개\n`;
    summaryLog += `- 총 검토 메일 수: ${totalUnreadMessagesCount}개\n`;
    summaryLog += `- 캘린더 일정 등록 완료: ${registeredEventsCount}건\n`;
    summaryLog += `- 일정 미포함 (일반 메일): ${nonEventCount}건\n`;
    if (errorCount > 0) {
      summaryLog += `- 오류 발생 건수: ${errorCount}건\n`;
    }
    
    if (createdEventsSummary.length > 0) {
      summaryLog += `\n[등록된 일정 세부 목록]\n`;
      summaryLog += createdEventsSummary.join('\n') + `\n`;
    }
    summaryLog += `==================================================`;

    if (errorDetailsSummary.length > 0) {
      summaryLog += `\n[오류 발생 원인 목록]\n`;
      summaryLog += errorDetailsSummary.join('\n') + `\n`;
    }

    Logger.log(summaryLog);

  } finally {
    // 스크립트 종료 시 반드시 락 해제
    lock.releaseLock();
    Logger.log('[INFO] 스크립트 락 해제 및 프로세스 종료 완료.');
  }
}