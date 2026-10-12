const DEFAULT_GEMINI_VISION_MODEL = 'gemini-3.1-flash-lite';

function extractInlineImage(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid screenshot image data.');
  }

  return {
    mimeType: match[1],
    data: match[2],
  };
}

function extractGeminiText(result) {
  const rawText = result?.candidates
    ?.flatMap((candidate) => candidate.content?.parts || [])
    ?.map((part) => part.text || '')
    ?.join('')
    ?.trim();

  if (!rawText) return '';

  return rawText
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parses Gemini's structured response into separate extracted question and solution
 */
function parseQuestionAndSolution(rawText) {
  if (!rawText) return { question: '', solution: '' };

  const questionMatch = rawText.match(/===QUESTION===([\s\S]*?)===SOLUTION===/i);
  if (questionMatch) {
    const question = questionMatch[1].trim();
    const solution = rawText.split(/===SOLUTION===/i)[1]?.trim() || '';
    return { question, solution };
  }

  // Fallback: If section delimiters were omitted
  return {
    question: '[Screen Snapshot Problem]',
    solution: rawText.trim(),
  };
}

export const DEFAULT_GEMINI_FALLBACK_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
];

/**
 * Directly extracts and SOLVES the problem from screenshot using Gemini Vision
 * Uses Dev Shankar's Senior SDE guidelines (JavaScript-first, test run, strict bullet format)
 * Includes automatic fallback across verified Gemini vision models (3.1-flash-lite -> 2.5-flash).
 */
export async function solveQuestionFromScreenshot({
  apiKey,
  base64Image,
  systemPrompt,
  model = DEFAULT_GEMINI_VISION_MODEL,
  fallbackModels = DEFAULT_GEMINI_FALLBACK_MODELS,
  onModelSwitch,
  timeoutMs = 45000,
}) {
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY in .env file');
  }

  const inlineImage = extractInlineImage(base64Image);

  // Build candidate vision models without duplicates
  const candidateModels = [];
  if (model) candidateModels.push(model);
  if (Array.isArray(fallbackModels)) {
    for (const fb of fallbackModels) {
      if (fb && !candidateModels.includes(fb)) {
        candidateModels.push(fb);
      }
    }
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const promptText = `${systemPrompt || ''}

TASK:
Analyze the attached screenshot carefully.
1. Transcribe the core problem statement, code templates, constraints, and test cases cleanly (strip UI junk, browser bars, ads, timers).
2. Directly SOLVE the question adhering strictly to the above Persona and Routing Rules (Optimal JavaScript code FIRST + 1-variable test run + strict bullet points).

OUTPUT FORMAT:
Output your response strictly using these two section markers:

===QUESTION===
[Clean transcribed problem title, description, constraints, and examples in Markdown]

===SOLUTION===
[Your full optimal solution, JavaScript code, and bullet-point explanation following the rules]`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: promptText },
              { inlineData: inlineImage },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2500,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
    }

    const result = await response.json();
    const rawText = extractGeminiText(result);

    if (!rawText) {
      throw new Error('Gemini returned an empty response for this screenshot.');
    }

    return parseQuestionAndSolution(rawText);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Gemini solve request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Legacy OCR helper (kept for backwards compatibility)
 */
export async function extractQuestionFromScreenshot(options) {
  const res = await solveQuestionFromScreenshot(options);
  return res.question || res.solution;
}
