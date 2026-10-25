/**
 * Dooray! 메일을 감지하여 Gemini API로 일정을 파싱한 후 Google Calendar에 등록합니다.
 */


function autoSyncDoorayMailToCalendar() {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const doorayMail = PropertiesService.getScriptProperties().getProperty('DOORAY_MAIL');
  const calendarId = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');

  if (!apiKey) {
    Logger.log('[ERROR] GEMINI_API_KEY 스크립트 속성이 설정되지 않았습니다.');
    return;
  }
  if (!doorayMail) {
    Logger.log('[ERROR] DOORAY_MAIL 스크립트 속성이 설정되지 않았습니다.');
    return;
  }

  if (!calendarId) {
    Logger.log('[ERROR] CALENDAR_ID 스크립트 속성이 설정되지 않았습니다.');
    return;
  }

  const searchQuery = `is:unread from:(${doorayMail})`; // 감지할 메일 검색 쿼리

  Logger.log(`[INFO] 검색된 쿼리 확인: ${searchQuery}`);

  // 지정된 쿼리에 해당하는 읽지 않은 메일 검색
  const threads = GmailApp.search(searchQuery);
  const calendar = CalendarApp.getCalendarById(calendarId);

  Logger.log(`[INFO] 검색된 메일 스레드 수 : ${threads.length}`);

  for (const thread of threads) {
    const messages = thread.getMessages();
    for (const msg of messages) {
      if (!msg.isUnread()) continue; // 이미 읽은 메일은 건너뜀

      const subject = msg.getSubject();
      const body = msg.getPlainBody();
      const mailDate = msg.getDate();

      Logger.log(`----------------------------------------`);
      Logger.log(`[INFO] 메일 처리중 : ${subject}`);

      // Gemini API를 사용하여 메일에서 일정 객체 추출
      const parsedEvent = parseEmailWithGemini(subject, body, mailDate, apiKey);

      if (parsedEvent === null) {
        Logger.log(`[ERROR] 서버 과부하나 기타 문제로 인해 Gemini API 오류로 메일 처리를 실패했습니다. 메일을 휴지통으로 보내지 않고 다음 기회에 재시도합니다.`);
        continue; // 이 메일에 대한 삭제/읽음 처리를 스킵하고 다음 메일로 넘어감
      }

      if (parsedEvent && parsedEvent.isEvent && parsedEvent.startDate) {
        try {
          const startTime = new Date(parsedEvent.startDate);
          let endTime;

          if (parsedEvent.endDate) {
            endTime = new Date(parsedEvent.endDate);
          } else {
            // 종료 시간이 명시되지 않은 경우 시작 시간 기준 1시간 후로 설정
            Logger.log(`[INFO] 종료 시간이 명시되지 않아 임의로 시작 시간 기준 1시간 후로 설정하였습니다.`);
            endTime = new Date(startTime.getTime() + 60 * 60 * 1000);
          }

          const descriptionText = parsedEvent.summary 
            ? `[Dooray 메일 연동]\n\n${parsedEvent.summary}` 
            : `[Dooray 메일 연동]\n\n${body}`;

          // 종일 일정 여부 체크 (시간 정보가 없거나 00:00:00인 경우)
          if (parsedEvent.isAllDay) {
            calendar.createAllDayEvent(parsedEvent.title || subject, startTime, {
              description: descriptionText,
              location: parsedEvent.location || ''
            });
          } else {
            Logger.log(`[INFO] 시간 정보가 명시되지 않거나 하루 동안 진행되는 이벤트라서 임의로 종일 이벤트로 설정하였습니다.`);
            calendar.createEvent(parsedEvent.title || subject, startTime, endTime, {
              description: descriptionText,
              location: parsedEvent.location || ''
            });
          }

          Logger.log(`[SUCCESS] 일정 등록 완료 : ${parsedEvent.title} (${parsedEvent.startDate})`);
        } catch (e) {
          Logger.log(`[ERROR] 일정 등록 실패 : ${e.message}`);
        }
      } else {
        Logger.log('[INFO] 일정 정보가 없거나 행사 메일이 아닌 것으로 판단됨.');
      }

      // 처리한 메일은 읽음 처리하여 중복 수집 방지 및 삭제
      msg.markRead();
      thread.moveToTrash();
      Logger.log('[INFO] 메일 처리 완료 및 휴지통 이동 완료')
    }
  }
}


/**
 * Gemini API를 호출하여 메일 본문에서 일정을 JSON으로 추출
 */


function parseEmailWithGemini(subject, body, mailDate, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${apiKey}`;
  
  const todayStr = Utilities.formatDate(mailDate, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");

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
4. summary 필드에는 캘린더 상세 내용에 들어가기 좋도록 메일의 핵심 내용(행사 목적, 주요 안내 사항, 준비물 등)을 4~5줄 내외로 깔끔하게 요약해 주세요.
5. 순수 JSON 객체 이외의 설명이나 마크다운 백틱은 절대 포함하지 마세요.

[JSON 출력 포맷]:
{
  "isEvent": true,
  "title": "행사/대회명 (또는 '[마감] OO 신청')",
  "startDate": "YYYY-MM-DDTHH:mm:ss",
  "endDate": "YYYY-MM-DDTHH:mm:ss 또는 null",
  "isAllDay": true 또는 false,
  "location": "장소 또는 온라인 링크 (없으면 빈 문자열)",
  "summary": "메일 내용의 핵심 요약 내용 (4~5줄)"
}
`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  // 503 에러 등의 이유로 실패할 경우 최대 3번까지 재시도
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const responseText = response.getContentText();
      const json = JSON.parse(responseText);
      
      if (json.candidates && json.candidates[0].content.parts[0].text) {
        const rawText = json.candidates[0].content.parts[0].text.trim();
        Logger.log(`[INFO] Gemini raw 응답 : \n${rawText}`);
        return JSON.parse(rawText);
      } else {
        // 503 에러 등 서버 과부하 응답인지 확인
        Logger.log(`[ERROR] Gemini 응답 오류 (시도 ${attempt}/${maxRetries}) : ${responseText}`);
        
        // 마지막 시도가 아니라면 2초 대기 후 재시도
        if (attempt < maxRetries) {
          Utilities.sleep(2000); 
          continue;
        }
      }
    } catch (e) {
      Logger.log(`[ERROR] Gemini API 파싱 중 예외 발생 (시도 ${attempt}/${maxRetries}) : ${e.message}`);
      if (attempt < maxRetries) {
        Utilities.sleep(2000);
        continue;
      }
    }
  }
  
  return null;
}
