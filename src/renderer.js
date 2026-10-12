import './index.css';
import 'katex/dist/katex.min.css';
import { marked } from 'marked';
import renderMathInElement from 'katex/contrib/auto-render';
import { streamChatCompletion, DEV_SENIOR_SDE_PROMPT } from './chatService';
import { solveQuestionFromScreenshot } from './geminiVisionService';

// Configure marked for code & formatting
marked.setOptions({
  gfm: true,
  breaks: true,
});

// Helper for rendering Markdown + KaTeX Math with Obsidian Code Terminals
function renderFormattedContent(container, markdownText) {
  container.innerHTML = marked.parse(markdownText || '');

  // Render KaTeX Math formulas (e.g. $O(N)$, $\mathcal{O}(V+E)$)
  renderMathInElement(container, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
      { left: '\\(', right: '\\)', display: false },
      { left: '\\[', right: '\\]', display: true },
    ],
    throwOnError: false,
  });

  // Wrap all <pre> blocks into Obsidian Code Terminals
  container.querySelectorAll('pre').forEach((preBlock) => {
    if (preBlock.closest('.code-container')) return;

    const codeElem = preBlock.querySelector('code');
    let lang = 'CODE';
    if (codeElem) {
      const classNames = codeElem.className.split(' ');
      for (const cls of classNames) {
        if (cls.startsWith('language-')) {
          lang = cls.replace('language-', '').toUpperCase();
          break;
        }
      }
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'code-container select-text';

    const header = document.createElement('div');
    header.className = 'code-header';

    const langTag = document.createElement('span');
    langTag.className = 'code-lang-tag';
    langTag.textContent = lang;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'code-copy-btn';
    copyBtn.innerHTML = `<span>📋</span> <span>Copy</span>`;
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const rawCode = codeElem ? codeElem.innerText : preBlock.innerText;
      navigator.clipboard.writeText(rawCode);
      copyBtn.innerHTML = `<span>✅</span> <span class="text-emerald-400">Copied!</span>`;
      setTimeout(() => {
        copyBtn.innerHTML = `<span>📋</span> <span>Copy</span>`;
      }, 1800);
    });

    header.appendChild(langTag);
    header.appendChild(copyBtn);

    preBlock.parentNode.insertBefore(wrapper, preBlock);
    wrapper.appendChild(header);
    wrapper.appendChild(preBlock);
  });
}

// Convert model IDs to clean, concise display names in parentheses
function formatModelShortName(modelId) {
  if (!modelId) return 'Groq';
  const id = modelId.toLowerCase();
  if (id.includes('120b')) return 'GPT 120B';
  if (id.includes('20b')) return 'GPT 20B';
  if (id.includes('qwen') && (id.includes('27b') || id.includes('3.8'))) return 'Qwen 27B';
  if (id.includes('qwen')) return 'Qwen';
  if (id.includes('70b')) return 'Llama 70B';
  if (id.includes('8b')) return 'Llama 8B';
  if (id.includes('gemini')) {
    const versionMatch = id.match(/gemini-(\d+(?:\.\d+)?)/i);
    if (versionMatch) {
      return `Gemini ${versionMatch[1]}`;
    }
    return 'Gemini';
  }
  if (id.includes('claude')) return 'Claude';
  const parts = modelId.split('/');
  const name = parts[parts.length - 1];
  return name.length > 12 ? name.substring(0, 12) : name;
}

// DOM Elements
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
const chatSidebar = document.getElementById('chatSidebar');
const snapBtn = document.getElementById('snapBtn');
const micBtn = document.getElementById('micBtn');
const micLabel = document.getElementById('micLabel');
const audioSourceBtn = document.getElementById('audioSourceBtn');
const audioSourceLabel = document.getElementById('audioSourceLabel');
const liveTranscript = document.getElementById('liveTranscript');
const audioVisualizer = document.getElementById('audioVisualizer');
const sendVoiceNowBtn = document.getElementById('sendVoiceNowBtn');
const errorNotificationBanner = document.getElementById('errorNotificationBanner');
const errorNotificationText = document.getElementById('errorNotificationText');
const newChatTopBtn = document.getElementById('newChatTopBtn');
const newChatSidebarBtn = document.getElementById('newChatSidebarBtn');
const opacitySlider = document.getElementById('opacitySlider');
const minBtn = document.getElementById('minBtn');
const closeBtn = document.getElementById('closeBtn');
const chatSessionsList = document.getElementById('chatSessionsList');
const headerChatTitle = document.getElementById('headerChatTitle');
const currentChatBadge = document.getElementById('currentChatBadge');
const messagesContainer = document.getElementById('messagesContainer');
const promptInput = document.getElementById('promptInput');
const sendBtn = document.getElementById('sendBtn');
const scrollNavGroup = document.getElementById('scrollNavGroup');
const navPrevAnsBtn = document.getElementById('navPrevAnsBtn');
const navLatestAnsBtn = document.getElementById('navLatestAnsBtn');
const statusDot = document.getElementById('statusDot');
const statusPing = document.getElementById('statusPing');

// State Variables
let sessions = [];
let activeSessionId = null;
let isGenerating = false;
let currentAbortController = null;
let userScrolledUp = false; // When true, prevents auto-scrolling so user can read earlier content

// Audio & Deepgram State
let isListening = false;
let socket = null;
let mediaRecorder = null;
let audioStream = null;
let audioMode = 'recruiter'; // 'recruiter' (System Loopback) or 'me' (Microphone)
let accumulatedQuestion = '';
let currentInterimText = '';
let silenceDebounceTimer = null;

// Settings State
let appSettings = {
  geminiKey: '',
  geminiVisionModel: 'gemini-3.1-flash-lite',
  groqKey: '',
  groqModel: 'openai/gpt-oss-120b',
  deepgramKey: '',
};

// Initialize App
async function initApp() {
  try {
    const env = await window.electronAPI.getEnv();
    appSettings.geminiKey = env.GEMINI_API_KEY || '';
    appSettings.geminiVisionModel = env.GEMINI_VISION_MODEL || 'gemini-3.1-flash-lite';
    appSettings.groqKey = env.GROQ_API_KEY || '';
    appSettings.groqModel = env.GROQ_MODEL || 'openai/gpt-oss-120b';
    appSettings.deepgramKey = env.DEEPGRAM_API_KEY || '';
  } catch (err) {
    console.error('Failed to get env:', err);
  }

  // Load Sessions
  loadSessionsFromStorage();

  if (sessions.length === 0) {
    createNewChatSession();
  } else {
    switchSession(sessions[0].id);
  }

  setupEventListeners();
  updateVisualizer(false);
}

let notificationTimer = null;

function showAppNotification(message, isError = false) {
  if (!errorNotificationBanner || !errorNotificationText) return;

  clearTimeout(notificationTimer);
  errorNotificationText.textContent = (isError ? '⚠️ ' : 'ℹ️ ') + message;
  
  if (isError) {
    errorNotificationBanner.className = 'px-3.5 py-1.5 bg-rose-950/95 border-b border-rose-500/50 text-[11px] text-rose-200 font-mono leading-snug break-words transition-all duration-200 z-10 shadow-lg';
  } else {
    errorNotificationBanner.className = 'px-3.5 py-1.5 bg-cyan-950/95 border-b border-cyan-500/50 text-[11px] text-cyan-200 font-mono leading-snug break-words transition-all duration-200 z-10 shadow-lg';
  }

  // Exactly 5 seconds auto-dismiss
  notificationTimer = setTimeout(() => {
    if (errorNotificationBanner) {
      errorNotificationBanner.className = 'hidden';
      if (errorNotificationText) errorNotificationText.textContent = '';
    }
  }, 5000);
}

function loadSessionsFromStorage() {
  try {
    const raw = localStorage.getItem('stealth_chat_sessions');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Keep non-empty sessions and at most one empty session
        const nonEmpty = parsed.filter((s) => s.messages && s.messages.length > 0);
        const empty = parsed.filter((s) => !s.messages || s.messages.length === 0);
        sessions = empty.length > 0 ? [empty[0], ...nonEmpty] : nonEmpty;
      }
    }
  } catch (e) {
    console.error('Error parsing sessions:', e);
    sessions = [];
  }
}

function saveSessionsToStorage() {
  try {
    localStorage.setItem('stealth_chat_sessions', JSON.stringify(sessions));
  } catch (e) {
    console.error('Error saving sessions:', e);
  }
}

function createNewChatSession() {
  const activeSession = getActiveSession();
  // If the active session is already fresh with 0 context, reuse it
  if (activeSession && (!activeSession.messages || activeSession.messages.length === 0)) {
    switchSession(activeSession.id);
    promptInput?.focus();
    return;
  }

  // If any other session is empty, switch to it instead of creating another
  const existingEmptySession = sessions.find((s) => !s.messages || s.messages.length === 0);
  if (existingEmptySession) {
    switchSession(existingEmptySession.id);
    promptInput?.focus();
    return;
  }

  // Only create a new session if all existing threads have messages/context
  const newSession = {
    id: 'session_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    title: 'Problem ' + (sessions.length + 1),
    createdAt: Date.now(),
    messages: [],
  };

  sessions.unshift(newSession);
  saveSessionsToStorage();
  renderSidebarSessions();
  switchSession(newSession.id);
  promptInput?.focus();
}

function switchSession(sessionId) {
  if (isGenerating && currentAbortController) {
    currentAbortController.abort();
    isGenerating = false;
  }

  userScrolledUp = false;
  activeSessionId = sessionId;
  renderSidebarSessions();
  renderActiveChat();
}

function deleteSession(sessionId, e) {
  if (e) e.stopPropagation();

  sessions = sessions.filter((s) => s.id !== sessionId);
  saveSessionsToStorage();

  if (activeSessionId === sessionId) {
    if (sessions.length > 0) {
      switchSession(sessions[0].id);
    } else {
      createNewChatSession();
    }
  } else {
    renderSidebarSessions();
  }
}

function getActiveSession() {
  let session = sessions.find((s) => s.id === activeSessionId);
  if (!session && sessions.length > 0) {
    activeSessionId = sessions[0].id;
    session = sessions[0];
  }
  return session;
}

function renderSidebarSessions() {
  if (!chatSessionsList) return;
  chatSessionsList.innerHTML = '';

  sessions.forEach((s) => {
    const isActive = s.id === activeSessionId;
    const item = document.createElement('div');
    item.className = `group flex items-center justify-between px-3 py-2 rounded-lg text-xs cursor-pointer transition-all duration-150 ${
      isActive
        ? 'bg-gradient-to-r from-indigo-950/90 to-blue-950/80 border border-indigo-500/50 text-white font-semibold shadow-md'
        : 'hover:bg-white/[0.06] text-slate-300 hover:text-white border border-transparent'
    }`;

    item.innerHTML = `
      <div class="flex items-center gap-2 truncate">
        <span class="text-xs">${s.messages.some((m) => m.imagePreview) ? '📷' : '💬'}</span>
        <span class="truncate">${escapeHtml(s.title)}</span>
      </div>
      <button class="delete-session-btn opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-400 p-1 text-xs transition" title="Delete thread">✕</button>
    `;

    item.addEventListener('click', () => switchSession(s.id));
    item.querySelector('.delete-session-btn').addEventListener('click', (e) => deleteSession(s.id, e));

    chatSessionsList.appendChild(item);
  });
}

function renderActiveChat() {
  const session = getActiveSession();
  if (!session || !messagesContainer) return;

  if (headerChatTitle) headerChatTitle.textContent = session.title;
  if (currentChatBadge) currentChatBadge.textContent = `${appSettings.groqModel || 'Groq'}`;

  // Check and preserve previous scroll position if reading previous content
  const previousScrollTop = messagesContainer.scrollTop;
  const wasScrolledUp = userScrolledUp;

  messagesContainer.innerHTML = '';

  if (session.messages.length === 0) {
    userScrolledUp = false;
    updateScrollButtonVisibility();
    const emptyState = document.createElement('div');
    emptyState.className = 'p-4 bg-white/[0.04] rounded-xl border border-white/10 backdrop-blur-md text-slate-300 space-y-2 shadow-lg';
    emptyState.innerHTML = `
      <div class="flex items-center gap-2 text-white font-bold text-xs">
        <span class="text-cyan-400">✨</span> Dev • Senior SDE Copilot Ready
      </div>
      <p class="text-[11px] text-slate-300 leading-relaxed">
        • Press <strong class="text-white bg-white/10 px-1.5 py-0.5 rounded border border-white/15">Ctrl+Shift+S</strong> or click <strong class="text-cyan-300 font-semibold">📷 Snap</strong> to extract problem text (Strings, Arrays, Trees, Graphs, Lists, System Design) & solve.<br/>
        • Click <strong class="text-cyan-300 font-semibold">🎙️ Start</strong> for live speech-to-solution stream.<br/>
        • Ask follow-ups with full contextual thread memory in simple, conversational English.
      </p>
    `;
    messagesContainer.appendChild(emptyState);
    return;
  }

  session.messages.forEach((msg) => {
    appendMessageToDOM(msg, false);
  });

  if (wasScrolledUp) {
    messagesContainer.scrollTop = previousScrollTop;
    updateScrollButtonVisibility();
  } else {
    scrollToBottom(false);
  }
}

function appendMessageToDOM(msg, shouldScroll = true) {
  const isUser = msg.role === 'user';
  const bubble = document.createElement('div');
  bubble.id = `msg-${msg.id}`;
  bubble.className = `p-3 rounded-xl text-[11px] space-y-1.5 animate-fade-in ${
    isUser
      ? 'bg-white/[0.05] border border-white/12 ml-4 backdrop-blur-md shadow-md text-slate-100 user-bubble'
      : 'bg-[#04060a]/90 border border-cyan-500/30 mr-1 backdrop-blur-xl shadow-xl assistant-bubble'
  }`;

  if (isUser) {
    const isVoice = msg.source === 'voice';
    const isSnap = msg.source === 'snap' || !!msg.imagePreview;
    bubble.innerHTML = `
      <div class="flex items-center justify-between text-[9.5px] text-cyan-300 font-bold uppercase tracking-wider">
        <span class="flex items-center gap-1.5">
          <span>${isSnap ? '📷' : (isVoice ? '🎙️' : '👤')}</span>
          <span>${isSnap ? 'Question Extracted (Gemini)' : (isVoice ? 'You (Spoken)' : 'You')}</span>
        </span>
        <span class="text-slate-400 font-mono text-[8.5px]">${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      ${msg.imagePreview ? `<div class="mt-1.5 overflow-hidden rounded-lg border border-white/15 shadow-inner max-h-36"><img src="${msg.imagePreview}" class="w-full h-auto object-contain hover:scale-105 transition duration-300" alt="Screen preview" /></div>` : ''}
      <div class="extracted-question markdown-body text-white font-normal leading-relaxed break-words text-[10.5px]"></div>
    `;
    const questionContainer = bubble.querySelector('.extracted-question');
    if (questionContainer) {
      renderFormattedContent(questionContainer, msg.displayContent || (typeof msg.content === 'string' ? msg.content : ''));
    }
  } else {
    const isGeminiSolve = msg.source === 'gemini';
    const rawModel = msg.model || (isGeminiSolve ? (appSettings.geminiVisionModel || 'gemini') : (appSettings.groqModel || 'Groq'));
    const shortModelName = formatModelShortName(rawModel);

    bubble.innerHTML = `
      <div class="flex items-center justify-between text-[10px] text-emerald-400 font-bold uppercase tracking-wider pb-1.5 border-b border-white/10">
        <span class="flex items-center gap-1.5">
          <span class="text-cyan-400">⚡</span>
          <span class="copilot-solution-title text-white font-extrabold tracking-wide">Copilot Solution (${shortModelName})</span>
        </span>
        <span class="text-slate-400 font-mono text-[9px]">${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="answer-content markdown-body select-text space-y-1 text-slate-100"></div>
    `;
    const contentElem = bubble.querySelector('.answer-content');
    renderFormattedContent(contentElem, msg.displayContent || (typeof msg.content === 'string' ? msg.content : ''));
  }

  messagesContainer?.appendChild(bubble);

  if (shouldScroll) {
    scrollToBottom(false);
  }

  return bubble;
}

function scrollToBottom(force = false) {
  if (!messagesContainer) return;

  // If force is false and the user is scrolled up reading earlier content, do NOT scroll
  if (!force && userScrolledUp) {
    updateScrollButtonVisibility();
    return;
  }

  messagesContainer.scrollTop = messagesContainer.scrollHeight;
  userScrolledUp = false;
  updateScrollButtonVisibility();
}

// Scroll directly to the top/beginning of an answer bubble
function scrollToAnswer(target = 'latest') {
  if (!messagesContainer) return;

  const assistantBubbles = Array.from(messagesContainer.querySelectorAll('.assistant-bubble'));
  if (assistantBubbles.length === 0) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    userScrolledUp = false;
    updateScrollButtonVisibility();
    return;
  }

  let targetElem = null;
  if (target === 'prev') {
    // 2nd to last answer if available, otherwise the only answer
    if (assistantBubbles.length >= 2) {
      targetElem = assistantBubbles[assistantBubbles.length - 2];
    } else {
      targetElem = assistantBubbles[0];
    }
  } else {
    // 'latest' answer
    targetElem = assistantBubbles[assistantBubbles.length - 1];
  }

  if (targetElem) {
    // Scroll so the top of this answer bubble is cleanly aligned near top of viewport
    targetElem.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Check if after scrolling we are near bottom or above
    setTimeout(() => {
      if (!messagesContainer) return;
      const distanceFromBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
      userScrolledUp = distanceFromBottom > 80;
      updateScrollButtonVisibility();
    }, 350);
  }
}

function updateScrollButtonVisibility() {
  if (!messagesContainer || !scrollNavGroup) return;

  const assistantBubbles = messagesContainer.querySelectorAll('.assistant-bubble');
  const distanceFromBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;

  // Show navigation bar if there are answers and the user has scrolled up or there are multiple answers
  if (assistantBubbles.length > 0 && distanceFromBottom > 60) {
    scrollNavGroup.classList.remove('hidden');

    // Only show "Prev Ans" button if there are at least 2 answers to navigate between
    if (navPrevAnsBtn) {
      if (assistantBubbles.length >= 2) {
        navPrevAnsBtn.classList.remove('hidden');
      } else {
        navPrevAnsBtn.classList.add('hidden');
      }
    }
  } else {
    scrollNavGroup.classList.add('hidden');
  }
}

function updateVisualizer(active) {
  if (!audioVisualizer) return;
  if (active) {
    audioVisualizer.classList.add('active');
    audioVisualizer.classList.remove('opacity-40');
    audioVisualizer.classList.add('opacity-100');
  } else {
    audioVisualizer.classList.remove('active');
    audioVisualizer.classList.add('opacity-40');
    audioVisualizer.classList.remove('opacity-100');
  }
}

// Screen Capture & Direct Gemini Problem Solver Pipeline
async function handleScreenSnap() {
  if (isGenerating) return;

  let session = getActiveSession();
  if (!session) {
    createNewChatSession();
    session = getActiveSession();
  }
  if (!session) return;

  if (!appSettings.geminiKey) {
    showAppNotification('Missing GEMINI_API_KEY in .env file', true);
    return;
  }

  isGenerating = true;
  if (statusDot) statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-amber-400 shadow-[0_0_10px_#fbbf24]';
  if (statusPing) statusPing.className = 'animate-ping absolute inline-flex h-2.5 w-2.5 rounded-full bg-amber-400 opacity-75';
  if (currentChatBadge) currentChatBadge.textContent = 'Gemini Solving...';
  if (liveTranscript) liveTranscript.textContent = 'Analyzing problem & computing optimal solution with Gemini...';

  try {
    const base64Image = await window.electronAPI.captureScreen();
    if (!base64Image) {
      showAppNotification('Failed to capture screen', true);
      resetStatusDot();
      isGenerating = false;
      return;
    }

    // Step 1: Gemini directly extracts problem and generates optimal solution
    let result = null;
    try {
      result = await solveQuestionFromScreenshot({
        apiKey: appSettings.geminiKey,
        base64Image,
        systemPrompt: DEV_SENIOR_SDE_PROMPT,
        model: appSettings.geminiVisionModel,
      });
    } catch (geminiErr) {
      console.error('Gemini direct solve error:', geminiErr);
      showAppNotification(`Snap failed: ${geminiErr.message}`, true);
      resetStatusDot();
      isGenerating = false;
      return;
    }

    const { question, solution } = result;

    // Step 2: Store extracted question into thread as User message
    const userMsgId = 'msg_' + Date.now();
    const userMsg = {
      id: userMsgId,
      role: 'user',
      content: question, // Stored as text for Groq follow-up awareness
      displayContent: question,
      imagePreview: base64Image,
      source: 'snap',
      timestamp: Date.now(),
    };
    session.messages.push(userMsg);

    // Auto-title thread smartly from question
    if (session.messages.length === 1) {
      const cleanTitle = question
        .replace(/[#*`_>]/g, '')
        .split('\n')[0]
        .trim();
      session.title = cleanTitle.length > 28 ? cleanTitle.substring(0, 28) + '...' : (cleanTitle || `Problem ${sessions.indexOf(session) + 1}`);
      renderSidebarSessions();
      if (headerChatTitle) headerChatTitle.textContent = session.title;
    }

    // Step 3: Store Gemini's solution into thread as Assistant message
    const assistantMsgId = 'msg_' + (Date.now() + 1);
    const assistantMsg = {
      id: assistantMsgId,
      role: 'assistant',
      content: solution, // Stored as pure text for Groq follow-ups
      displayContent: solution,
      source: 'gemini',
      timestamp: Date.now(),
    };
    session.messages.push(assistantMsg);

    saveSessionsToStorage();
    renderActiveChat();
    scrollToAnswer('latest');
  } catch (err) {
    console.error('Screen snap error:', err);
    showAppNotification(`Snap failed: ${err.message}`, true);
  } finally {
    isGenerating = false;
    resetStatusDot();
    if (currentChatBadge) currentChatBadge.textContent = `${appSettings.groqModel || 'Groq'}`;
  }
}

function resetStatusDot() {
  if (statusDot) statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-emerald-400 shadow-[0_0_10px_#34d399]';
  if (statusPing) statusPing.className = 'animate-ping absolute inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400 opacity-60';
}

// Follow-up Text / Voice Question Handler
async function handleSendPrompt(customText = '', isVoice = false) {
  if (isGenerating && currentAbortController) {
    console.log('Aborting previous response to answer new question...');
    currentAbortController.abort();
    isGenerating = false;
  }

  let session = getActiveSession();
  if (!session) {
    createNewChatSession();
    session = getActiveSession();
  }
  if (!session) return;

  const text = (customText || promptInput?.value || '').trim();
  if (!text) return;

  if (!appSettings.groqKey) {
    showAppNotification('Missing GROQ_API_KEY in .env file', true);
    return;
  }

  if (promptInput) {
    promptInput.value = '';
    promptInput.style.height = 'auto';
  }

  const userMsgId = 'msg_' + Date.now();
  const userMsg = {
    id: userMsgId,
    role: 'user',
    content: text,
    displayContent: text,
    source: isVoice ? 'voice' : 'text',
    timestamp: Date.now(),
  };

  session.messages.push(userMsg);

  if (session.messages.length === 1) {
    session.title = text.length > 25 ? text.substring(0, 25) + '...' : text;
    renderSidebarSessions();
    if (headerChatTitle) headerChatTitle.textContent = session.title;
  }

  saveSessionsToStorage();
  renderActiveChat();

  await runAssistantResponse(session);
}

// Run Assistant Stream Completion with Groq
async function runAssistantResponse(session) {
  isGenerating = true;
  currentAbortController = new AbortController();

  const assistantMsgId = 'msg_' + Date.now();
  const assistantMsg = {
    id: assistantMsgId,
    role: 'assistant',
    content: '',
    displayContent: '',
    timestamp: Date.now(),
  };

  session.messages.push(assistantMsg);

  const assistantBubble = appendMessageToDOM(assistantMsg, true);
  const contentContainer = assistantBubble.querySelector('.answer-content');
  contentContainer.innerHTML = '<span class="text-cyan-400 font-medium animate-pulse text-[11px] flex items-center gap-1.5"><span>⚡</span> <span>Computing optimal solution with Groq...</span></span>';

  if (currentChatBadge) currentChatBadge.textContent = `Streaming...`;
  if (statusDot) statusDot.className = 'relative inline-flex rounded-full h-2 w-2 bg-cyan-400 shadow-[0_0_10px_#22d3ee]';
  if (statusPing) statusPing.className = 'animate-ping absolute inline-flex h-2.5 w-2.5 rounded-full bg-cyan-400 opacity-80';

  try {
    // Send full conversation history in text format to Groq for full context awareness
    await streamChatCompletion({
      apiKey: appSettings.groqKey,
      model: appSettings.groqModel,
      messages: session.messages.slice(0, -1),
      signal: currentAbortController.signal,
      onReasoning: (accumulatedReasoning) => {
        contentContainer.innerHTML = `<div class="p-2 bg-indigo-950/40 border border-indigo-500/30 rounded-lg text-indigo-300 text-[11px] font-mono leading-relaxed max-h-24 overflow-y-auto mb-2"><div class="text-[9px] uppercase font-bold text-indigo-400 mb-1 flex items-center gap-1"><span>🧠</span> <span>Dev Thinking...</span></div>${escapeHtml(accumulatedReasoning.slice(-180))}...</div>`;
        scrollToBottom();
      },
      onChunk: (accumulated) => {
        assistantMsg.content = accumulated;
        assistantMsg.displayContent = accumulated;
        renderFormattedContent(contentContainer, accumulated);
        scrollToBottom();
      },
      onComplete: (finalText) => {
        assistantMsg.content = finalText;
        assistantMsg.displayContent = finalText;
        renderFormattedContent(contentContainer, finalText);
        saveSessionsToStorage();
      },
      onError: (err) => {
        if (err.name === 'AbortError') {
          contentContainer.innerHTML += '<div class="text-amber-400 text-[10px] mt-1 font-mono">[Response stopped]</div>';
        } else {
          contentContainer.innerHTML = `<div class="p-2.5 bg-rose-950/70 border border-rose-700/80 rounded-lg text-rose-200 text-xs">⚠️ ${escapeHtml(err.message)}</div>`;
        }
      },
    });
  } catch (err) {
    console.error('Chat stream error:', err);
  } finally {
    isGenerating = false;
    currentAbortController = null;
    if (currentChatBadge) currentChatBadge.textContent = `${appSettings.groqModel || 'Groq'}`;
    resetStatusDot();
    saveSessionsToStorage();
  }
}

// --- Deepgram Real-Time Audio Pipeline ---
async function startListening() {
  const deepgramKey = appSettings.deepgramKey;

  if (!deepgramKey) {
    showAppNotification('Missing DEEPGRAM_API_KEY in .env file', true);
    return;
  }

  try {
    if (audioMode === 'me') {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });
    } else {
      // Recruiter / Friend mode via DisplayMedia Loopback (System Audio)
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      displayStream.getVideoTracks().forEach((t) => t.stop());
      const audioTracks = displayStream.getAudioTracks();

      if (audioTracks.length === 0) {
        showAppNotification('Check "Share audio" in popup window', true);
        stopListening();
        return;
      }
      audioStream = new MediaStream(audioTracks);
    }

    socket = new WebSocket(
      'wss://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&interim_results=true&endpointing=1500',
      ['token', deepgramKey]
    );

    socket.onopen = () => {
      mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
          socket.send(event.data);
        }
      };
      mediaRecorder.start(250);

      isListening = true;
      if (micBtn) {
        micBtn.className = 'text-[11px] px-2.5 py-1 rounded-lg bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 text-white font-bold shadow-[0_0_14px_rgba(244,63,94,0.45)] border border-rose-400/40 transition-all duration-150 active:scale-95 flex items-center gap-1';
        if (micLabel) micLabel.textContent = 'Stop';
      }
      if (liveTranscript) liveTranscript.textContent = 'Listening to voice stream...';
      updateVisualizer(true);
    };

    accumulatedQuestion = '';
    currentInterimText = '';

    socket.onmessage = (message) => {
      try {
        const data = JSON.parse(message.data);
        const text = data.channel?.alternatives[0]?.transcript || '';

        // If we just submitted this question, ignore trailing echo packets from the mic
        if (voiceSubmissionCooldown) {
          return;
        }

        if (text.trim().length > 0) {
          currentInterimText = text.trim();
          if (liveTranscript) liveTranscript.textContent = currentInterimText;
        }

        if (data.is_final && text.trim().length > 0) {
          accumulatedQuestion = (accumulatedQuestion + ' ' + text.trim()).trim();
          currentInterimText = '';
        }

        if (!isGenerating && (accumulatedQuestion.length > 0 || currentInterimText.length > 0)) {
          if (data.speech_final || text.trim().length > 0) {
            resetSilenceTimer(2300);
          }
        }
      } catch (err) {
        console.error('Error parsing transcription packet:', err);
      }
    };

    socket.onerror = (err) => {
      console.error('Deepgram Error:', err);
      stopListening();
    };

    socket.onclose = () => {
      stopListening();
    };
  } catch (err) {
    console.error('Audio capture error:', err);
    showAppNotification('Audio capture failed. Check audio device.', true);
    stopListening();
  }
}

function resetSilenceTimer(delayMs = 2300) {
  clearTimeout(silenceDebounceTimer);
  silenceDebounceTimer = setTimeout(() => {
    processQuestionIfReady();
  }, delayMs);
}

// Client-side quick phonetic cleaning dictionary for common speech-to-text slips
function cleanPhoneticMistranscriptions(text) {
  if (!text) return '';
  return text
    .replace(/\bnext\s*(gs|js|g\.s)\b/gi, 'Next.js')
    .replace(/\bjungle\b/gi, 'Django')
    .replace(/\b(reck|rad|reg|rack)\b/gi, 'RAG')
    .replace(/\bgrock(\s*api)?\b/gi, 'Groq')
    .replace(/\b(lang\s*chain|line\s*chain)\b/gi, 'LangChain')
    .replace(/\b(salery|salary)\b/gi, (match) => {
      // In tech/job interview context, keep if followed by expectations/compensation
      return 'Celery';
    })
    .replace(/\b(post\s*grease|post\s*grass)\b/gi, 'PostgreSQL')
    .replace(/\bread\s*this\b/gi, 'Redis')
    .replace(/\b(m\s*c\s*p|empty\s*p)\b/gi, 'Model Context Protocol (MCP)');
}

let lastProcessedVoiceQuestion = '';
let voiceSubmissionCooldown = false;

function processQuestionIfReady() {
  clearTimeout(silenceDebounceTimer);
  silenceDebounceTimer = null;

  let finalQuestion = (accumulatedQuestion + ' ' + (currentInterimText || '')).trim();

  // Reset buffers immediately so no secondary triggers can grab the same text
  accumulatedQuestion = '';
  currentInterimText = '';

  if (finalQuestion.length >= 3) {
    finalQuestion = cleanPhoneticMistranscriptions(finalQuestion);

    // Prevent duplicate submission if the exact same question was submitted within last 4 seconds
    if (voiceSubmissionCooldown || finalQuestion.toLowerCase() === lastProcessedVoiceQuestion.toLowerCase()) {
      console.log('[Voice] Ignored duplicate speech packet:', finalQuestion);
      return;
    }

    lastProcessedVoiceQuestion = finalQuestion;
    voiceSubmissionCooldown = true;
    setTimeout(() => {
      voiceSubmissionCooldown = false;
      lastProcessedVoiceQuestion = '';
    }, 4000);

    console.log('[Voice] Submitting spoken question to Groq:', finalQuestion);
    if (liveTranscript) liveTranscript.textContent = 'Solving spoken question with Groq...';
    handleSendPrompt(finalQuestion, true);
  }
}

function stopListening() {
  clearTimeout(silenceDebounceTimer);

  // If there was any speech transcribed, process it before shutting down
  processQuestionIfReady();

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (audioStream) {
    audioStream.getTracks().forEach((track) => track.stop());
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }

  isListening = false;
  if (micBtn) {
    micBtn.className = 'text-[11px] px-2.5 py-1 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold shadow-[0_0_12px_rgba(6,182,212,0.35)] border border-cyan-400/30 transition-all duration-150 active:scale-95 flex items-center gap-1';
    if (micLabel) micLabel.textContent = 'Start';
  }
  setTimeout(() => {
    if (!isListening && liveTranscript) {
      liveTranscript.textContent = 'Ready to transcribe speech...';
    }
  }, 1200);
  updateVisualizer(false);
}

// Setup Event Listeners
function setupEventListeners() {
  // Audio Source Toggle ('me' vs 'recruiter' / friend)
  audioSourceBtn?.addEventListener('click', () => {
    if (audioMode === 'me') {
      audioMode = 'recruiter';
      if (audioSourceLabel) audioSourceLabel.textContent = 'Friend';
      audioSourceBtn.className = 'text-[11px] px-2 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 font-semibold shadow-[0_0_10px_rgba(245,158,11,0.2)] transition-all duration-150 active:scale-95 flex items-center gap-1';
    } else {
      audioMode = 'me';
      if (audioSourceLabel) audioSourceLabel.textContent = 'Me';
      audioSourceBtn.className = 'text-[11px] px-2 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 font-semibold shadow-[0_0_10px_rgba(16,185,129,0.2)] transition-all duration-150 active:scale-95 flex items-center gap-1';
    }

    if (isListening) {
      stopListening();
      startListening();
    }
  });

  // Voice Mic Toggle
  micBtn?.addEventListener('click', async () => {
    if (!isListening) {
      await startListening();
    } else {
      stopListening();
    }
  });

  // Send Transcribed Speech Immediately (Up Arrow) without waiting 2.3s
  sendVoiceNowBtn?.addEventListener('click', () => {
    processQuestionIfReady();
  });

  // Sidebar Toggle
  toggleSidebarBtn?.addEventListener('click', () => {
    chatSidebar?.classList.toggle('hidden');
  });

  // New Chat Buttons
  newChatTopBtn?.addEventListener('click', createNewChatSession);
  newChatSidebarBtn?.addEventListener('click', createNewChatSession);
  window.electronAPI?.onTriggerNewChat?.(createNewChatSession);

  // Screen Snap Trigger
  snapBtn?.addEventListener('click', handleScreenSnap);
  window.electronAPI?.onTriggerScreenCapture?.(handleScreenSnap);

  // Send Prompt Actions
  sendBtn?.addEventListener('click', () => handleSendPrompt());

  promptInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendPrompt();
    }
  });

  // Quick prompt buttons
  document.querySelectorAll('.quick-prompt-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prompt = btn.getAttribute('data-prompt');
      if (prompt) {
        handleSendPrompt(prompt);
      }
    });
  });

  // Scroll detection: pause auto-scrolling when user scrolls up to read earlier answers
  messagesContainer?.addEventListener('scroll', () => {
    const distanceFromBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight;
    // If user is more than 80px from bottom, they are reading above content -> don't autoscroll
    if (distanceFromBottom > 80) {
      userScrolledUp = true;
    } else {
      userScrolledUp = false;
    }
    updateScrollButtonVisibility();
  });

  // Floating navigation buttons to jump to start of latest or previous answer
  navPrevAnsBtn?.addEventListener('click', () => {
    scrollToAnswer('prev');
  });

  navLatestAnsBtn?.addEventListener('click', () => {
    scrollToAnswer('latest');
  });

  // Window Controls
  opacitySlider?.addEventListener('input', (e) => window.electronAPI?.setOpacity?.(e.target.value));
  minBtn?.addEventListener('click', () => window.electronAPI?.minimize?.());
  closeBtn?.addEventListener('click', () => window.electronAPI?.close?.());
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Start application reliably
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
