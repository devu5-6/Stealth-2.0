/**
 * Dev's Senior SDE System Prompt: Hands-on DSA, Debugging, System Design, Behavioral & Experience Copilot
 */
export const DEV_SENIOR_SDE_PROMPT = `Role: Dev Shankar, Sr SDE (1.3 YOE). Tone: Simple, easy, conversational, zero fluff.
Stack: Next.js, React, JS, Node, Python, FastAPI, Postgres, Redis, RAG, LangChain, LLMs, CS core, HLD/LLD & Scaling.

EXP:
1. Artifex One: AI WhatsApp Scheduler (Redis, 50-100 req/s, <200ms latency, saved 2h/day). Secure LLM (PII redaction, 800+ patients/mo, 0 leaks). Multilingual CMS (CI/CD).
2. Leapcraft ApS: AirBird App (Expo, TS, Node, Postgres, 50+ IoT, 1k+ users). White-labeling (-70% overhead). Svelte Dashboard (25+ metrics, 95+ Lighthouse). Python Analytics (-80% manual work).

STRICT ROUTING RULES:
*AUDIO FIXES: Silently correct STT typos (next GS->Next.js, jungle->Django, Red/Reg/Rack/rad/Reck->RAG, MC P/MCP/empty p->MCP, post grease->Postgres).

[1] EXP / PROJECTS:
- 1 direct opening sentence.
- EXACTLY 5-6 Bullets: 1. Goal 2. Scale 3. Engineering (tech used) 4. Reliability 5. Impact 6. Lesson.

[2] DSA / CODING:
- Optimal JS (ES6) code FIRST.
- NO SHORTCUTS: NEVER use \`.sort()\`, \`.reverse()\`, \`.includes()\` in loops. Code from scratch (Maps, Sets, 2-Pointers, Sliding Window).
- Bottom of code: 1-variable test run (e.g., \`const n=153; console.log(fn(n));\`). NO array loops unless input is an array.
- EXACTLY 6-7 Bullets: 1. Intuition/Approach 2. Data Structures 3. Walkthrough 4. State updates 5. Time ($\\mathcal{O}(N)$) 6. Space ($\\mathcal{O}(1)$) 7. Edge Cases.

[3] DEBUGGING:
- Fixed JS code FIRST + test run block.
- EXACTLY 5 Bullets: 1. Root Cause 2. Symptom 3. Fix Logic 4. Edge Cases 5. Senior Tip.

[4] BEHAVIORAL / SCENARIOS:
- Attack prompt directly. NO personal intros/stories to start.
- 1 direct opening sentence + EXACTLY 6 Bullets.
- Bullets 1-4: Action plan (Triage, Strategy, Execution, Resilience).
- Bullets 5-6: Real-world anchor (Artifex/Leapcraft) + Metric outcome.

[5] SYS DESIGN/MCQ:
- Direct answer FIRST.
- EXACTLY 5 simple bullets.`;

/**
 * Clean & sanitize text to eliminate junk tokens and whitespace
 */
function sanitizeMessageContent(content) {
  if (!content) return '';
  let str = '';
  if (typeof content === 'string') {
    str = content;
  } else if (Array.isArray(content)) {
    str = content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  } else {
    str = String(content);
  }

  return str
    .replace(/\[Response stopped\]/gi, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Smart Context Compactor for Groq Free Tier
 * - Keeps root problem definition (Anchor 1).
 * - Keeps initial code solution (Anchor 2).
 * - Retains recent 4-6 conversation turns for active follow-ups.
 */
export function buildOptimizedContext(rawMessages, maxRecentTurns = 6) {
  const cleanList = [];

  for (const m of rawMessages) {
    const text = sanitizeMessageContent(m.content || m.displayContent);
    if (text.length > 0) {
      cleanList.push({
        role: m.role || 'user',
        content: text,
      });
    }
  }

  if (cleanList.length <= maxRecentTurns + 2) {
    return cleanList;
  }

  const anchorMessages = cleanList.slice(0, 2);
  const recentMessages = cleanList.slice(-maxRecentTurns);

  const seen = new Set();
  const result = [];

  for (const msg of [...anchorMessages, ...recentMessages]) {
    if (!seen.has(msg)) {
      seen.add(msg);
      result.push(msg);
    }
  }

  return result;
}

/**
 * Streams completion from Groq API with reasoning and content extraction
 * @param {Object} params
 * @param {string} params.apiKey
 * @param {string} [params.baseUrl]
 * @param {string} [params.model]
 * @param {Array} params.messages
 * @param {Function} [params.onChunk]
 * @param {Function} [params.onReasoning]
 * @param {Function} [params.onError]
 * @param {Function} [params.onComplete]
 * @param {AbortSignal} [params.signal]
 */
export async function streamChatCompletion({
  apiKey,
  baseUrl = 'https://api.groq.com/openai/v1',
  model = 'qwen/qwen3.8-27b',
  messages,
  onChunk,
  onReasoning,
  onError,
  onComplete,
  signal,
}) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('Missing GROQ_API_KEY in .env file.');
  }

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const sanitizedHistory = buildOptimizedContext(messages);

  const formattedMessages = [
    { role: 'system', content: DEV_SENIOR_SDE_PROMPT },
    ...sanitizedHistory,
  ];

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'qwen/qwen3.8-27b',
        messages: formattedMessages,
        stream: true,
        temperature: 0.1,
        max_completion_tokens: 1500,
      }),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      let errorMsg = `Groq API Error (${response.status}): ${errText}`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error && parsed.error.message) {
          errorMsg = `Groq API Error: ${parsed.error.message}`;
        }
      } catch (_) {}
      throw new Error(errorMsg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = '';
    let accumulatedReasoning = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const payload = trimmed.replace(/^data:\s*/, '');
        if (payload === '[DONE]') {
          if (onComplete) onComplete(accumulatedText);
          return accumulatedText;
        }

        try {
          const parsed = JSON.parse(payload);
          const deltaContent = parsed.choices?.[0]?.delta?.content || '';
          const deltaReasoning = parsed.choices?.[0]?.delta?.reasoning || '';

          if (deltaReasoning) {
            accumulatedReasoning += deltaReasoning;
            if (onReasoning) onReasoning(accumulatedReasoning, deltaReasoning);
          }

          if (deltaContent) {
            accumulatedText += deltaContent;
            if (onChunk) onChunk(accumulatedText, deltaContent);
          }
        } catch (_) {
          // ignore partial JSON chunks
        }
      }
    }

    if (onComplete) onComplete(accumulatedText);
    return accumulatedText;
  } catch (err) {
    if (onError) onError(err);
    throw err;
  }
}
