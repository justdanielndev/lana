'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { AnimatePresence, motion } from 'framer-motion';
import { appwriteAccount, hasAppwriteConfig, ID } from '../lib/appwrite-client';

const assistantSentenceVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      delay: 0.01,
      when: 'beforeChildren',
    },
  },
};

const assistantLetterVariants = {
  hidden: { opacity: 0 },
  visible: (index = 0) => ({
    opacity: 1,
    transition: {
      delay: 0.02 + (index * 0.035),
      duration: 0.16,
      ease: [0.22, 1, 0.36, 1],
    },
  }),
};

function formatDateLabel(isoDate) {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function isParamError(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('missing required parameter') ||
    message.includes('unknown parameter') ||
    message.includes('invalid parameter') ||
    message.includes('invalid type for parameter')
  );
}

function isActiveSessionConflict(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('creation of a session is prohibited when a session is active') ||
    message.includes('session is active')
  );
}

function formatAppwriteError(error) {
  const parts = [];

  if (typeof error?.code === 'number') {
    parts.push(`code ${error.code}`);
  }

  if (typeof error?.type === 'string' && error.type.trim()) {
    parts.push(error.type.trim());
  }

  const primaryMessage = typeof error?.message === 'string' && error.message.trim()
    ? error.message.trim()
    : null;

  const responseMessage = typeof error?.response?.message === 'string' && error.response.message.trim()
    ? error.response.message.trim()
    : null;

  if (primaryMessage) {
    parts.push(primaryMessage);
  }

  if (responseMessage && responseMessage !== primaryMessage) {
    parts.push(responseMessage);
  }

  if (parts.length === 0) {
    return 'Unknown Appwrite error';
  }

  return parts.join(' | ');
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const normalized = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    return JSON.parse(atob(normalized));
  } catch (_) {
    return null;
  }
}

function getJwtExpiryMs(token) {
  const payload = decodeJwtPayload(token);
  const exp = Number(payload?.exp);
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return exp * 1000;
}

const EMPTY_MESSAGES = [];
const DEFAULT_ONBOARDING_PROFILE = {
  ownerName: 'Zoe',
  lanaName: 'Lana',
  lanaPersonality: 'friendly, helpful, and cute',
};
const ONBOARDING_CONVERSATION_ID = '__onboarding__';

function convertSlackMrkdwnToMarkdown(input) {
  const source = String(input || '');
  if (!source) return '';

  const placeholders = [];
  const stash = (value) => {
    const key = `@@SLACK_SEGMENT_${placeholders.length}@@`;
    placeholders.push(value);
    return key;
  };

  let working = source
    .replace(/```[\s\S]*?```/g, (match) => stash(match))
    .replace(/`[^`\n]+`/g, (match) => stash(match));

  working = working.replace(/<([^>\n]+)>/g, (_full, innerRaw) => {
    const inner = String(innerRaw || '').trim();
    if (!inner) return '';

    if (inner.startsWith('!date^')) {
      const fallback = inner.split('|')[1];
      return fallback ? fallback.trim() : '';
    }

    if (inner === '!here' || inner === '!channel' || inner === '!everyone') {
      return `@${inner.slice(1)}`;
    }

    if (inner.startsWith('!subteam^')) {
      const [, rest = ''] = inner.split('^');
      const [idOrName, label] = rest.split('|');
      return `@${(label || idOrName || 'subteam').trim()}`;
    }

    if (inner.startsWith('@')) {
      const [id, label] = inner.slice(1).split('|');
      return `@${(label || id || '').trim()}`;
    }

    if (inner.startsWith('#')) {
      const [id, label] = inner.slice(1).split('|');
      return `#${(label || id || '').trim()}`;
    }

    if (inner.includes('|')) {
      const [url, label] = inner.split('|');
      const safeUrl = String(url || '').trim();
      const safeLabel = String(label || url || '').trim();
      if (!safeUrl) return safeLabel;
      return `[${safeLabel}](${safeUrl})`;
    }

    return `<${inner}>`;
  });

  working = working
    .replace(/(^|[^\w\\])\*([^\s*][^*]*?[^\s*])\*(?=[^\w]|$)/g, '$1**$2**')
    .replace(/(^|[^\w\\])_([^\s_][^_]*?[^\s_])_(?=[^\w]|$)/g, '$1*$2*')
    .replace(/(^|[^\w\\])~([^\s~][^~]*?[^\s~])~(?=[^\w]|$)/g, '$1~~$2~~');

  working = working.replace(/@@SLACK_SEGMENT_(\d+)@@/g, (_full, index) => {
    const value = placeholders[Number(index)];
    return typeof value === 'string' ? value : '';
  });

  return working;
}

function tokenizeCustomEmoji(text) {
  const raw = String(text || '');
  const tokens = [];
  const pattern = /:([a-z0-9][a-z0-9_+-]*):/gi;
  let lastIndex = 0;
  let match = pattern.exec(raw);

  while (match) {
    const [fullMatch, emojiName] = match;
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: raw.slice(lastIndex, match.index) });
    }
    tokens.push({ type: 'emoji', value: emojiName.toLowerCase(), raw: fullMatch });
    lastIndex = match.index + fullMatch.length;
    match = pattern.exec(raw);
  }

  if (lastIndex < raw.length) {
    tokens.push({ type: 'text', value: raw.slice(lastIndex) });
  }

  return tokens;
}

function renderContentWithCustomEmoji(text, customEmojiFiles) {
  const tokens = tokenizeCustomEmoji(text);
  if (tokens.length === 0) return text;

  return tokens.map((token, index) => {
    if (token.type === 'text') {
      return <span key={`text-${index}`}>{token.value}</span>;
    }

    const fileName = customEmojiFiles[token.value];
    if (!fileName) {
      return <span key={`emoji-fallback-${index}`}>{token.raw}</span>;
    }

    return (
      <img
        key={`emoji-${index}`}
        className="custom-emoji"
        src={`/emojis/${fileName}`}
        alt={token.raw}
        title={token.raw}
      />
    );
  });
}

function buildMarkdownWithCustomEmoji(text, customEmojiFiles) {
  const mrkdwn = convertSlackMrkdwnToMarkdown(text);
  const tokens = tokenizeCustomEmoji(mrkdwn);
  if (tokens.length === 0) {
    return mrkdwn;
  }

  return tokens
    .map((token) => {
      if (token.type === 'text') {
        return token.value;
      }
      const fileName = customEmojiFiles[token.value];
      if (!fileName) {
        return token.raw;
      }
      return `![${token.raw}](/emojis/${fileName})`;
    })
    .join('');
}

function renderMarkdownMessage(text, customEmojiFiles) {
  const markdown = buildMarkdownWithCustomEmoji(text, customEmojiFiles);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        img: ({ ...props }) => {
          const isCustomEmoji = typeof props.src === 'string' && props.src.startsWith('/emojis/');
          return (
            <img
              {...props}
              className={isCustomEmoji ? 'custom-emoji' : 'message-image'}
              loading="lazy"
            />
          );
        },
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}

function tokenizeAssistantAnimatedText(source) {
  const tokens = [];
  const htmlTagPattern = /(<\/?[a-zA-Z][^>]*>)/g;
  const normalizedSource = String(source || '');
  let cursor = 0;
  let match = htmlTagPattern.exec(normalizedSource);

  const pushTextTokens = (text) => {
    const parts = tokenizeCustomEmoji(text);
    parts.forEach((part) => {
      if (part.type === 'emoji') {
        tokens.push({ type: 'emoji', value: part.value, raw: part.raw });
        return;
      }
      const chunks = String(part.value || '').match(/(\s+|[^\s]+)/g) || [];
      chunks.forEach((chunk) => {
        if (!chunk) return;
        if (/^\s+$/.test(chunk)) {
          tokens.push({ type: 'space', value: chunk });
        } else {
          tokens.push({ type: 'word', value: chunk });
        }
      });
    });
  };

  while (match) {
    const tagStart = match.index;
    const tagText = match[0];

    if (tagStart > cursor) {
      pushTextTokens(normalizedSource.slice(cursor, tagStart));
    }

    tokens.push({ type: 'tag', value: tagText });
    cursor = tagStart + tagText.length;
    match = htmlTagPattern.exec(normalizedSource);
  }

  if (cursor < normalizedSource.length) {
    pushTextTokens(normalizedSource.slice(cursor));
  }

  return tokens;
}

function renderAnimatedAssistantMessage(messageId, text, customEmojiFiles) {
  const source = String(text || '');
  if (!source) return null;
  const tokens = tokenizeAssistantAnimatedText(source);
  let animatedIndex = 0;

  return (
    <motion.p
      key={`assistant-text-${messageId}`}
      className="message-markdown animated-message-text"
      variants={assistantSentenceVariants}
      initial="hidden"
      animate="visible"
    >
      {tokens.map((token, index) => {
        if (token.type === 'emoji') {
          const fileName = customEmojiFiles?.[token.value];
          const tokenIndex = animatedIndex;
          animatedIndex += 1;
          return (
            <motion.span key={`${token.type}-${index}`} variants={assistantLetterVariants} custom={tokenIndex}>
              {fileName ? (
                <img
                  className="custom-emoji"
                  src={`/emojis/${fileName}`}
                  alt={token.raw || `:${token.value}:`}
                  title={token.raw || `:${token.value}:`}
                />
              ) : (
                token.raw || `:${token.value}:`
              )}
            </motion.span>
          );
        }

        if (token.type === 'space') {
          return (
            <span key={`${token.type}-${index}`}>
              {token.value.replace(/ /g, '\u00A0')}
            </span>
          );
        }

        return (
          <motion.span
            key={`${token.type}-${index}`}
            variants={assistantLetterVariants}
            custom={animatedIndex++}
          >
            {token.value}
          </motion.span>
        );
      })}
    </motion.p>
  );
}

export default function HomePage() {
  const [booting, setBooting] = useState(true);
  const [authEmail, setAuthEmail] = useState('');
  const [authOtp, setAuthOtp] = useState('');
  const [otpUserId, setOtpUserId] = useState('');
  const [otpPhrase, setOtpPhrase] = useState('');
  const [otpRequested, setOtpRequested] = useState(false);
  const [authError, setAuthError] = useState('');
  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);

  const [jwt, setJwt] = useState(null);
  const [user, setUser] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [messages, setMessages] = useState(EMPTY_MESSAGES);
  const [composerText, setComposerText] = useState('');
  const [sending, setSending] = useState(false);
  const [completingOnboarding, setCompletingOnboarding] = useState(false);
  const [onboardingProfile, setOnboardingProfile] = useState(DEFAULT_ONBOARDING_PROFILE);
  const [onboardingStep, setOnboardingStep] = useState('name');
  const [onboardingInput, setOnboardingInput] = useState('');
  const [onboardingChat, setOnboardingChat] = useState([]);
  const [assistantTalking, setAssistantTalking] = useState(false);
  const [customEmojiFiles, setCustomEmojiFiles] = useState({});
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const eventSourceRef = useRef(null);
  const typingTimersRef = useRef(new Map());
  const pendingReactionsRef = useRef(new Map());
  const jwtRefreshPromiseRef = useRef(null);
  const composerTextareaRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const onboardingAssistantTimersRef = useRef(new Set());
  const onboardingNextAssistantDelayRef = useRef(700);
  const onboardingAssistantQueueRef = useRef(Promise.resolve());
  const onboardingAssistantRunIdRef = useRef(0);

  const isAuthenticated = Boolean(jwt && user);
  const hasPendingOnboarding = Boolean(isAuthenticated && user && !user?.onboardingCompleted);
  const isOnboardingThread = activeConversationId === ONBOARDING_CONVERSATION_ID;
  const onboardingLocked = hasPendingOnboarding;

  const onboardingConversation = useMemo(() => {
    if (!hasPendingOnboarding) return null;
    return {
      id: ONBOARDING_CONVERSATION_ID,
      title: 'New Chat',
      updatedAt: new Date().toISOString(),
    };
  }, [hasPendingOnboarding]);

  const conversationsForUi = useMemo(() => {
    if (!onboardingConversation) return conversations;
    return [onboardingConversation, ...conversations];
  }, [onboardingConversation, conversations]);

  const onboardingMessages = useMemo(
    () =>
      onboardingChat.map((item) => ({
        id: item.id,
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: item.text,
      })),
    [onboardingChat]
  );
  const messagesForUi = isOnboardingThread ? onboardingMessages : messages;

  function clearTypingTimers() {
    for (const timer of typingTimersRef.current.values()) {
      clearInterval(timer);
    }
    typingTimersRef.current.clear();
    setAssistantTalking(false);
  }

  function closeEventStream() {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }

  function scrollMessagesToBottom(behavior = 'smooth') {
    const node = messagesContainerRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  }

  function clearOnboardingAssistantTimers() {
    onboardingAssistantRunIdRef.current += 1;
    for (const timer of onboardingAssistantTimersRef.current) {
      clearTimeout(timer);
    }
    onboardingAssistantTimersRef.current.clear();
    onboardingNextAssistantDelayRef.current = 700;
    onboardingAssistantQueueRef.current = Promise.resolve();
    setAssistantTalking(false);
  }

  function resetComposerTextareaSize() {
    const node = composerTextareaRef.current;
    if (!node) return;
    node.style.height = '44px';
    node.style.overflowY = 'hidden';
  }

  function onComposerTextChange(event) {
    const node = event.target;
    setComposerText(node.value);

    node.style.height = '44px';
    const maxHeight = 120;
    const nextHeight = Math.min(node.scrollHeight, maxHeight);
    node.style.height = `${Math.max(44, nextHeight)}px`;
    node.style.overflowY = node.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }

  function onComposerKeyDown(event) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent?.isComposing) {
      return;
    }

    event.preventDefault();
    const form = event.currentTarget.form;
    if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit();
    }
  }

  function applyReactionToMessage(targetMessageId, emoji, reactionList = null) {
    const normalizedTarget = String(targetMessageId || '').trim();
    const normalizedEmoji = String(emoji || '').trim();
    if (!normalizedTarget || !normalizedEmoji) return;

    let applied = false;
    setMessages((prev) =>
      prev.map((message) => {
        if (message.id !== normalizedTarget) {
          return message;
        }

        applied = true;
        const nextReactions = Array.isArray(reactionList)
          ? reactionList
          : Array.from(new Set([...(Array.isArray(message.reactions) ? message.reactions : []), normalizedEmoji]));

        return {
          ...message,
          reactions: nextReactions,
        };
      })
    );

    if (!applied) {
      const existing = pendingReactionsRef.current.get(normalizedTarget) || [];
      const next = Array.isArray(reactionList)
        ? reactionList
        : Array.from(new Set([...existing, normalizedEmoji]));
      pendingReactionsRef.current.set(normalizedTarget, next);
    }
  }

  function consumePendingReactions(messageId) {
    const id = String(messageId || '').trim();
    if (!id) return null;
    const reactions = pendingReactionsRef.current.get(id) || null;
    if (reactions) {
      pendingReactionsRef.current.delete(id);
    }
    return reactions;
  }

  function appendLiveAssistantMessage(content, messageId) {
    const fullContent = String(content || '').trim();
    if (!fullContent) return;
    const resolvedId = String(messageId || `live-${Date.now()}`);

    setMessages((prev) => {
      if (prev.some((message) => message.id === resolvedId)) {
        return prev;
      }
      return [
        ...prev,
        {
          id: resolvedId,
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
          live: true,
        },
      ];
    });

    let cursor = 0;
    const chunkSize = Math.max(1, Math.ceil(fullContent.length / 24));
    const timer = setInterval(() => {
      cursor = Math.min(fullContent.length, cursor + chunkSize);
      setMessages((prev) =>
        prev.map((message) =>
          message.id === resolvedId
            ? { ...message, content: fullContent.slice(0, cursor), live: cursor < fullContent.length }
            : message
        )
      );
      scrollMessagesToBottom('auto');

      if (cursor >= fullContent.length) {
        const existing = typingTimersRef.current.get(resolvedId);
        if (existing) {
          clearInterval(existing);
          typingTimersRef.current.delete(resolvedId);
          setAssistantTalking(typingTimersRef.current.size > 0 || onboardingAssistantTimersRef.current.size > 0);
        }
      }
    }, 22);

    typingTimersRef.current.set(resolvedId, timer);
    setAssistantTalking(true);
    scrollMessagesToBottom('auto');
  }

  async function callAccount(methodNameOrNames, argsVariants) {
    if (!appwriteAccount) {
      throw new Error(
        'Appwrite client is not configured. Set NEXT_PUBLIC_APPWRITE_ENDPOINT and NEXT_PUBLIC_APPWRITE_PROJECT_ID.'
      );
    }

    const methodNames = Array.isArray(methodNameOrNames) ? methodNameOrNames : [methodNameOrNames];
    let lastError = null;
    let hasMatchingMethod = false;

    for (const methodName of methodNames) {
      if (typeof appwriteAccount[methodName] !== 'function') {
        continue;
      }

      hasMatchingMethod = true;

      for (const args of argsVariants) {
        try {
          return await appwriteAccount[methodName](...args);
        } catch (error) {
          lastError = error;
          if (isParamError(error)) {
            continue;
          }
          throw error;
        }
      }
    }

    if (lastError) {
      throw lastError;
    }

    if (!hasMatchingMethod) {
      throw new Error(`Appwrite SDK missing method(s): ${methodNames.join(', ')}`);
    }

    throw new Error(`Unable to call Appwrite method(s): ${methodNames.join(', ')}`);
  }

  async function refreshJwtFromSession() {
    const jwtResult = await callAccount(['createJWT'], [[]]);
    const nextToken = typeof jwtResult?.jwt === 'string' ? jwtResult.jwt : '';
    if (!nextToken) {
      throw new Error('Appwrite did not return a JWT.');
    }
    localStorage.setItem('zoe_web_jwt', nextToken);
    setJwt(nextToken);
    return nextToken;
  }

  async function ensureFreshJwt(currentToken, { force = false, minRemainingMs = 90 * 1000 } = {}) {
    if (!force && currentToken) {
      const expiryMs = getJwtExpiryMs(currentToken);
      if (!expiryMs || expiryMs - Date.now() > minRemainingMs) {
        return currentToken;
      }
    }

    if (!jwtRefreshPromiseRef.current) {
      jwtRefreshPromiseRef.current = refreshJwtFromSession().finally(() => {
        jwtRefreshPromiseRef.current = null;
      });
    }

    return jwtRefreshPromiseRef.current;
  }

  async function rawApiRequest(path, { method = 'GET', token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch (_) {
      payload = {};
    }

    return { response, payload };
  }

  async function apiRequest(path, { method = 'GET', token, body } = {}) {
    const initialToken = await ensureFreshJwt(token);
    let { response, payload } = await rawApiRequest(path, { method, token: initialToken, body });

    if (response.status === 401) {
      const refreshedToken = await ensureFreshJwt(initialToken, { force: true });
      ({ response, payload } = await rawApiRequest(path, {
        method,
        token: refreshedToken,
        body,
      }));
    }

    if (!response.ok) {
      throw new Error(payload.message || `Request failed (${response.status})`);
    }

    return payload;
  }

  async function deleteCurrentSession() {
    try {
      await callAccount(['deleteSession'], [['current'], [{ sessionId: 'current' }]]);
    } catch (_) {
    }
  }

  async function deleteAllSessions() {
    try {
      await callAccount(['deleteSessions'], [[]]);
    } catch (_) {
    }
  }

  async function sendEmailOtp(email) {
    const userId = ID.unique();
    const token = await callAccount(
      ['createEmailToken'],
      [
        [{ userId, email, phrase: true }],
        [userId, email, true],
        [{ userId, email }],
        [userId, email]
      ]
    );

    setOtpUserId(token?.userId || userId);
    setOtpPhrase(typeof token?.phrase === 'string' ? token.phrase : '');
    setOtpRequested(true);
    return token;
  }

  async function createOtpSession(userId, secret) {
    try {
      await callAccount(['createSession'], [[{ userId, secret }], [userId, secret]]);
      return;
    } catch (error) {
      if (!isActiveSessionConflict(error)) {
        throw error;
      }
    }

    await deleteCurrentSession();
    await deleteAllSessions();
    await callAccount(['createSession'], [[{ userId, secret }], [userId, secret]]);
  }

  async function fetchCurrentUserFromBackend(token) {
    const payload = await apiRequest('/api/me', { method: 'GET', token });
    return payload.user;
  }

  async function completeOnboarding(token, profile) {
    const payload = await apiRequest('/api/onboarding', {
      method: 'POST',
      token,
      body: profile,
    });
    return {
      onboardingCompleted: Boolean(payload?.onboardingCompleted),
      onboardingProfile: payload?.onboardingProfile || null,
    };
  }

  async function loadConversationMessages(token, conversationId) {
    const payload = await apiRequest(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'GET',
      token,
    });
    return payload.messages || [];
  }

  async function ensureConversationList(token) {
    let payload = await apiRequest('/api/conversations', { method: 'GET', token });
    let nextConversations = payload.conversations || [];

    if (nextConversations.length === 0) {
      const created = await apiRequest('/api/conversations', {
        method: 'POST',
        token,
        body: { title: 'New conversation' },
      });
      nextConversations = [created.conversation];
    }

    return nextConversations;
  }

  async function hydrateChatFromJwt(token) {
    const backendUser = await fetchCurrentUserFromBackend(token);
    const backendProfile = backendUser?.onboardingProfile && typeof backendUser.onboardingProfile === 'object'
      ? backendUser.onboardingProfile
      : null;
    const normalizedProfile = {
      ...DEFAULT_ONBOARDING_PROFILE,
      ...(backendProfile || {}),
    };

    const nextConversations = await ensureConversationList(token);
    const targetConversationId = nextConversations[0]?.id || null;
    const nextMessages = targetConversationId
      ? await loadConversationMessages(token, targetConversationId)
      : [];

    setJwt(token);
    setUser(backendUser);
    setConversations(nextConversations);
    setActiveConversationId(backendUser?.onboardingCompleted ? targetConversationId : ONBOARDING_CONVERSATION_ID);
    setMessages(nextMessages);
    setOnboardingProfile(normalizedProfile);
    if (!backendUser?.onboardingCompleted) {
      openOnboardingChat(normalizedProfile);
    }
  }

  function clearAuthState() {
    localStorage.removeItem('zoe_web_jwt');
    setJwt(null);
    setUser(null);
    setConversations([]);
    setActiveConversationId(null);
    setMessages(EMPTY_MESSAGES);
    setComposerText('');
    setOtpRequested(false);
    setOtpUserId('');
    setOtpPhrase('');
    setAuthOtp('');
    setCompletingOnboarding(false);
    setOnboardingProfile(DEFAULT_ONBOARDING_PROFILE);
  }

  async function onSendOtp(event) {
    event.preventDefault();
    setAuthError('');

    const email = authEmail.trim();
    if (!email) {
      setAuthError('Email is required.');
      return;
    }

    try {
      setSendingOtp(true);
      await deleteCurrentSession();
      await sendEmailOtp(email);
      setAuthOtp('');
    } catch (error) {
      setAuthError(`Failed to send OTP: ${formatAppwriteError(error)}`);
    } finally {
      setSendingOtp(false);
    }
  }

  async function onVerifyOtp(event) {
    event.preventDefault();
    setAuthError('');

    const otpCode = authOtp.trim();
    if (!otpRequested || !otpUserId) {
      setAuthError('Send OTP first.');
      return;
    }

    if (!otpCode) {
      setAuthError('OTP code is required.');
      return;
    }

    try {
      setVerifyingOtp(true);
      await createOtpSession(otpUserId, otpCode);
      const nextToken = await refreshJwtFromSession();
      await hydrateChatFromJwt(nextToken);
    } catch (error) {
      setAuthError(`Failed to verify OTP: ${formatAppwriteError(error)}`);
      clearAuthState();
      setAuthEmail(authEmail);
    } finally {
      setVerifyingOtp(false);
    }
  }

  async function onLogout() {
    await deleteCurrentSession();
    clearAuthState();
    setAuthError('');
  }

  async function onCreateConversation() {
    if (!jwt || onboardingLocked) return;

    try {
      closeEventStream();
      clearTypingTimers();
      const created = await apiRequest('/api/conversations', {
        method: 'POST',
        token: jwt,
        body: { title: 'New conversation' },
      });

      const nextConversations = [created.conversation, ...conversations];
      setConversations(nextConversations);
      setActiveConversationId(created.conversation.id);
      setMessages(EMPTY_MESSAGES);
      setMobileSidebarOpen(false);
    } catch (error) {
      setAuthError(error.message || 'Failed to create conversation.');
    }
  }

  function onOnboardingProfileChange(field, value) {
    setOnboardingProfile((prev) => ({
      ...prev,
      [field]: value,
    }));
  }

  function addOnboardingMessage(role, text) {
    setOnboardingChat((prev) => [
      ...prev,
      {
        id: `ob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role,
        text: String(text || ''),
      },
    ]);
  }

  function addOnboardingUserMessage(text) {
    addOnboardingMessage('user', text);
    onboardingNextAssistantDelayRef.current = 700;
  }

  function queueOnboardingAssistantMessage(text) {
    const delay = onboardingNextAssistantDelayRef.current;
    onboardingNextAssistantDelayRef.current = 400;
    const runId = onboardingAssistantRunIdRef.current;

    onboardingAssistantQueueRef.current = onboardingAssistantQueueRef.current.then(
      () =>
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            onboardingAssistantTimersRef.current.delete(timer);
            if (onboardingAssistantRunIdRef.current === runId) {
              addOnboardingMessage('assistant', text);
            }
            resolve();
            setAssistantTalking(typingTimersRef.current.size > 0 || onboardingAssistantTimersRef.current.size > 0);
          }, delay);
          onboardingAssistantTimersRef.current.add(timer);
          setAssistantTalking(true);
        })
    );
  }

  function openOnboardingChat(seedProfile = onboardingProfile) {
    clearOnboardingAssistantTimers();
    setActiveConversationId(ONBOARDING_CONVERSATION_ID);
    setOnboardingStep('name');
    setOnboardingInput(seedProfile?.ownerName || '');
    setOnboardingChat([
      { id: 'ob-intro', role: 'assistant', text: `Hi! I'm ${seedProfile?.lanaName || 'Lana'} :3` },
      { id: 'ob-q1', role: 'assistant', text: "What's your name?" },
    ]);
  }

  function closeOnboardingChat(force = false) {
    if (onboardingLocked && !force) return;
    clearOnboardingAssistantTimers();
    setOnboardingStep('name');
    setOnboardingInput('');
    if (conversations[0]?.id) {
      setActiveConversationId(conversations[0].id);
    }
    setMobileSidebarOpen(false);
  }

  async function onOnboardingContinue(answerInput = onboardingInput) {
    const value = String(answerInput || '').trim();
    if (!value) return;

    if (onboardingStep === 'name') {
      addOnboardingUserMessage(value);
      onOnboardingProfileChange('ownerName', value);
      setOnboardingStep('lana_name');
      setOnboardingInput(onboardingProfile?.lanaName || 'Lana');
      queueOnboardingAssistantMessage('Nice to meet you, ' + value + '!');
      queueOnboardingAssistantMessage("What would you like to name me? (I'm usually called Lana, but you can choose!)");
      return;
    }

    if (onboardingStep === 'lana_name') {
      addOnboardingUserMessage(value);
      onOnboardingProfileChange('lanaName', value);
      setOnboardingStep('personality');
      setOnboardingInput(onboardingProfile?.lanaPersonality || '');
      queueOnboardingAssistantMessage(`${value}... I like it!`);
      queueOnboardingAssistantMessage('What personality should I have?');
      return;
    }

    if (onboardingStep === 'personality') {
      addOnboardingUserMessage(value);
      onOnboardingProfileChange('lanaPersonality', value);
      setOnboardingStep('completing');
      setOnboardingInput('');
      queueOnboardingAssistantMessage('Perfect, we are ready. Starting chat...');
      setTimeout(() => {
        onCompleteOnboarding();
      }, 760);
    }
  }

  async function onCompleteOnboarding() {
    if (!jwt || completingOnboarding) return;

    try {
      setCompletingOnboarding(true);
      const result = await completeOnboarding(jwt, {
        ownerName: onboardingProfile.ownerName,
        lanaName: onboardingProfile.lanaName,
        lanaPersonality: onboardingProfile.lanaPersonality,
      });
      if (!result.onboardingCompleted) {
        throw new Error('Onboarding completion failed.');
      }
      setUser((prev) => (prev
        ? {
          ...prev,
          onboardingCompleted: true,
          onboardingProfile: result.onboardingProfile || onboardingProfile,
        }
        : prev));
      if (result.onboardingProfile) {
        setOnboardingProfile({ ...DEFAULT_ONBOARDING_PROFILE, ...result.onboardingProfile });
      }
      closeOnboardingChat(true);
    } catch (error) {
      const message = String(error?.message || '');
      if (message.includes('404') || message.includes('Invalid `documentId`')) {
        setUser((prev) => (prev ? { ...prev, onboardingCompleted: true } : prev));
        if (conversations[0]?.id) {
          setActiveConversationId(conversations[0].id);
        }
        return;
      }
      setAuthError(message || 'Failed to save onboarding.');
    } finally {
      setCompletingOnboarding(false);
    }
  }

  async function onSelectConversation(conversationId) {
    if (!jwt || conversationId === activeConversationId) return;
    if (onboardingLocked && conversationId !== ONBOARDING_CONVERSATION_ID) return;
    if (conversationId === ONBOARDING_CONVERSATION_ID) {
      closeEventStream();
      clearTypingTimers();
      openOnboardingChat(onboardingProfile);
      return;
    }

    try {
      closeEventStream();
      clearTypingTimers();
      const nextMessages = await loadConversationMessages(jwt, conversationId);
      setActiveConversationId(conversationId);
      setMessages(nextMessages);
      setMobileSidebarOpen(false);
    } catch (error) {
      setAuthError(error.message || 'Failed to load conversation.');
    }
  }

  async function onSendMessage(event) {
    event.preventDefault();
    if (!jwt || !activeConversationId || sending || assistantTalking) return;

    const content = composerText.trim();
    if (!content) return;

    if (isOnboardingThread) {
      setComposerText('');
      resetComposerTextareaSize();
      if (['name', 'lana_name', 'personality'].includes(onboardingStep)) {
        setOnboardingInput(content);
        await onOnboardingContinue(content);
      } else {
        addOnboardingMessage('assistant', 'Use the onboarding actions below to continue.');
      }
      return;
    }

    setComposerText('');
    resetComposerTextareaSize();
    setSending(true);

    const tempUserMessage = {
      id: `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setMessages((prev) => [...prev, tempUserMessage]);

    try {
      const payload = await apiRequest(
        `/api/conversations/${encodeURIComponent(activeConversationId)}/messages`,
        {
          method: 'POST',
          token: jwt,
          body: { content },
        }
      );

      const incomingMessages = payload.messages || [];
      const updatedConversation = payload.conversation;
      const incomingUserMessage =
        incomingMessages.find((message) => message.role === 'user') || null;
      const incomingAssistantMessages = incomingMessages.filter(
        (message) => message.role === 'assistant'
      );

      setMessages((prev) => {
        let replacedTemp = false;
        let next = prev
          .map((message) => {
            if (message.id === tempUserMessage.id) {
              replacedTemp = true;
              if (!incomingUserMessage) return null;
              const pendingReactions = consumePendingReactions(incomingUserMessage.id);
              if (pendingReactions && pendingReactions.length > 0) {
                return {
                  ...incomingUserMessage,
                  reactions: Array.from(
                    new Set([...(incomingUserMessage.reactions || []), ...pendingReactions])
                  ),
                };
              }
              return incomingUserMessage;
            }
            return message;
          })
          .filter(Boolean);

        if (!replacedTemp) {
          next = next.filter((message) => message.id !== tempUserMessage.id);
          if (incomingUserMessage && !next.some((message) => message.id === incomingUserMessage.id)) {
            const pendingReactions = consumePendingReactions(incomingUserMessage.id);
            next.push(
              pendingReactions && pendingReactions.length > 0
                ? {
                  ...incomingUserMessage,
                  reactions: Array.from(
                    new Set([...(incomingUserMessage.reactions || []), ...pendingReactions])
                  ),
                }
                : incomingUserMessage
            );
          }
        }

        for (const assistantMessage of incomingAssistantMessages) {
          if (!next.some((message) => message.id === assistantMessage.id)) {
            next.push(assistantMessage);
          }
        }

        return next;
      });

      if (updatedConversation) {
        setConversations((prev) => {
          const replaced = prev.map((conversation) =>
            conversation.id === updatedConversation.id ? updatedConversation : conversation
          );
          return replaced.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        });
      }
    } catch (error) {
      setMessages((prev) => {
        const withoutTemp = prev.filter((message) => message.id !== tempUserMessage.id);
        return [
          ...withoutTemp,
          {
            id: `temp-error-${Date.now()}`,
            role: 'assistant',
            content: `Error: ${error.message || 'Failed to send message.'}`,
            createdAt: new Date().toISOString(),
          },
        ];
      });
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    let isActive = true;

    async function bootstrap() {
      try {
        if (!hasAppwriteConfig || !appwriteAccount) {
          throw new Error(
            'Appwrite web config missing. Set NEXT_PUBLIC_APPWRITE_ENDPOINT and NEXT_PUBLIC_APPWRITE_PROJECT_ID in web/.env.local.'
          );
        }

        const storedJwt = localStorage.getItem('zoe_web_jwt');
        if (!storedJwt) {
          return;
        }

        try {
          const nextToken = await ensureFreshJwt(storedJwt, { force: true });
          await hydrateChatFromJwt(nextToken);
        } catch (_) {
          clearAuthState();
        }
      } catch (error) {
        if (isActive) {
          setAuthError(error.message || 'Failed to initialize web app.');
        }
      } finally {
        if (isActive) {
          setBooting(false);
        }
      }
    }

    bootstrap();

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!jwt) return undefined;

    const refreshTimer = setInterval(async () => {
      try {
        await ensureFreshJwt(jwt);
      } catch (_) {
      }
    }, 60 * 1000);

    return () => clearInterval(refreshTimer);
  }, [jwt]);

  useEffect(() => {
    let isActive = true;

    async function resolveEmojiFile(name) {
      const normalizedName = String(name || '').trim().toLowerCase();
      if (!normalizedName) return null;

      const extensions = ['gif', 'png', 'webp', 'jpg', 'jpeg'];
      for (const extension of extensions) {
        const fileName = `${normalizedName}.${extension}`;
        try {
          const response = await fetch(`/emojis/${fileName}`, { method: 'HEAD', cache: 'no-store' });
          if (response.ok) {
            return fileName;
          }
        } catch (_) {
        }
      }

      return null;
    }

    async function loadCustomEmojiManifest() {
      try {
        const response = await fetch('/emojis/manifest.json', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = await response.json();
        if (!isActive) return;
        const entries = Array.isArray(payload?.emojis) ? payload.emojis : [];
        const nextMap = {};

        for (const entry of entries) {
          if (typeof entry === 'string') {
            const name = entry.trim().toLowerCase();
            if (!name) continue;
            const resolvedFile = await resolveEmojiFile(name);
            if (!resolvedFile) continue;
            nextMap[name] = resolvedFile;
            continue;
          }

          if (entry && typeof entry === 'object') {
            const name = String(entry.name || '').trim().toLowerCase();
            const file = String(entry.file || '').trim();
            if (!name || !file) continue;
            nextMap[name] = file;
          }
        }

        setCustomEmojiFiles(nextMap);
      } catch (_) {
      }
    }

    loadCustomEmojiManifest();

    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!jwt || !activeConversationId || isOnboardingThread) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return undefined;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const streamUrl = `/api/conversations/${encodeURIComponent(activeConversationId)}/events?token=${encodeURIComponent(jwt)}`;
    const eventSource = new EventSource(streamUrl);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      if (!payload || payload.conversationId !== activeConversationId) {
        return;
      }

      if (payload.type === 'tool_message') {
        appendLiveAssistantMessage(payload.content, payload.messageId);
      } else if (payload.type === 'reaction') {
        applyReactionToMessage(payload.targetMessageId, payload.emoji, payload.reactions);
      }
    };

    eventSource.onerror = async () => {
      try {
        const nextToken = await ensureFreshJwt(jwt, { force: true });
        if (nextToken && nextToken !== jwt) {
          setJwt(nextToken);
        }
      } catch (_) {
      }
    };

    return () => {
      eventSource.close();
      if (eventSourceRef.current === eventSource) {
        eventSourceRef.current = null;
      }
    };
  }, [jwt, activeConversationId, isOnboardingThread]);

  useEffect(() => () => clearTypingTimers(), []);
  useEffect(() => () => clearOnboardingAssistantTimers(), []);
  useEffect(() => {
    const lastMessage = messagesForUi[messagesForUi.length - 1];
    if (!lastMessage) return;
    if (lastMessage.role === 'assistant' || lastMessage.live) {
      scrollMessagesToBottom('smooth');
    }
  }, [messagesForUi]);

  if (booting) {
    return (
      <main className="web-root">
        <section className="otp-screen">
          <div className="loading-shell">
            <div className="hero-brand-row">
              <span className="lana-mark otp-mark-large" aria-hidden="true" />
              <h1 className="otp-hero">Lana</h1>
            </div>
            <p className="otp-subtitle">Loading your workspace...</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="web-root">
      {!isAuthenticated && (
        <section className="otp-screen">
          <div className="otp-hero-wrap">
            <div className="hero-brand-row">
              <span className="lana-mark otp-mark-large" aria-hidden="true" />
              <h1 className="otp-hero">Lana</h1>
            </div>
            <p className="otp-subtitle">The first emotionally intelligent agent.</p>

            <div className="pt-8">
              <form onSubmit={onSendOtp} className={`auth-step ${otpRequested ? 'hidden' : ''}`}>
                <label className="field otp-field-large">
                  <input
                    type="email"
                    required
                    value={authEmail}
                    onChange={(event) => setAuthEmail(event.target.value)}
                    autoComplete="email"
                    placeholder="Enter your email"
                  />
                </label>

                <button
                  type="submit"
                  className="primary-btn w-full otp-cta otp-cta-large"
                  disabled={sendingOtp || !appwriteAccount}
                >
                  {sendingOtp ? 'Sending code...' : 'Continue with email'}
                </button>
              </form>

              <form onSubmit={onVerifyOtp} className={`auth-step ${otpRequested ? '' : 'hidden'}`}>
                <p className="mb-3">
                  Check your inbox for a code sent to <strong>{authEmail || 'your email'}</strong>.
                </p>
                <label className="field otp-field-large">
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder="Enter your OTP code"
                    value={authOtp}
                    onChange={(event) => setAuthOtp(event.target.value)}
                  />
                </label>

                <button
                  type="submit"
                  className="primary-btn w-full otp-cta otp-cta-large"
                  disabled={verifyingOtp || !otpRequested || !appwriteAccount}
                >
                  {verifyingOtp ? 'Verifying...' : 'Continue'}
                </button>
                <button
                  type="button"
                  className="ghost-btn w-full mt-2"
                  onClick={() => {
                    setOtpRequested(false);
                    setAuthOtp('');
                  }}
                  disabled={verifyingOtp}
                >
                  Use a different email
                </button>
              </form>

              {otpRequested && otpPhrase && (
                <p className="pt-4 text-sm">
                  Security phrase: <strong>{otpPhrase}</strong>. Use this to know the email is from us.
                </p>
              )}
              <p className="error">{authError}</p>
            </div>
          </div>
        </section>
      )}

      {isAuthenticated && (
        <section className="app-shell">
          <aside className={`sidebar ${mobileSidebarOpen ? 'open' : ''}`}>
            <div className="sidebar-head">
              <div className="brand-row">
                <span className="lana-logo-svg" aria-hidden="true" />
                <span className="lana-wordmark">{onboardingProfile?.lanaName || 'Lana'}</span>
              </div>
              <button type="button" className="sidebar-mobile-close" onClick={() => setMobileSidebarOpen(false)}>
                Close
              </button>
              <button type="button" className="sidebar-new-chat" onClick={onCreateConversation} disabled={onboardingLocked}>
                New chat
              </button>
            </div>

            <div className="conversation-list">
              <div className="conversation-group">Today</div>
              {conversationsForUi.map((conversation) => (
                <button
                  type="button"
                  key={conversation.id}
                  className={`conversation-item ${conversation.id === activeConversationId ? 'active' : ''}`}
                  disabled={onboardingLocked && conversation.id !== ONBOARDING_CONVERSATION_ID}
                  onClick={() => onSelectConversation(conversation.id)}
                >
                  <div className="conversation-title">{conversation.title || 'New conversation'}</div>
                  <div className="conversation-meta">{formatDateLabel(conversation.updatedAt)}</div>
                </button>
              ))}
            </div>

            <div className="sidebar-foot">
              <div className="stack-actions">
                <button type="button" className="footer-action">Help & feedback</button>
                <button type="button" className="footer-action" onClick={openOnboardingChat}>Settings</button>
                <button type="button" className="footer-action" onClick={onLogout}>Log out</button>
              </div>
            </div>
          </aside>
          <button
            type="button"
            className={`mobile-sidebar-backdrop ${mobileSidebarOpen ? 'open' : ''}`}
            aria-label="Close sidebar"
            onClick={() => setMobileSidebarOpen(false)}
          />

          <section className="chat-stage">
            <div className="mobile-chat-top">
              <button type="button" className="mobile-menu-btn" onClick={() => setMobileSidebarOpen(true)}>
                ☰
              </button>
              <div className="mobile-brand">
                <span className="lana-logo-svg" aria-hidden="true" />
                <span className="lana-wordmark">{onboardingProfile?.lanaName || 'Lana'}</span>
              </div>
            </div>
            <section className="panel">
              <div ref={messagesContainerRef} className={`messages ${messagesForUi.length === 0 ? 'messages-empty' : ''}`}>
                {messagesForUi.length === 0 ? (
                  <div className="chat-empty">
                    <h4 className="chat-empty-title">Hey {onboardingProfile?.ownerName || 'Zoe'}, how can I help?</h4>
                  </div>
                ) : (
                  <div className="message-thread">
                    <AnimatePresence initial={false}>
                      {messagesForUi.map((message) => {
                        const role = message.role === 'assistant' ? 'assistant' : 'user';
                        const messageClass = [
                          'message',
                          role,
                          message.pending ? 'is-sending' : '',
                          message.live ? 'is-receiving' : '',
                        ]
                          .filter(Boolean)
                          .join(' ');
                        return (
                          <motion.div
                            key={message.id}
                            className={messageClass}
                            initial={role === 'assistant' ? { opacity: 0, x: -36 } : { opacity: 0, y: 12 }}
                            animate={role === 'assistant' ? { opacity: 1, x: 0 } : { opacity: 1, y: 0 }}
                            exit={role === 'assistant' ? { opacity: 0, x: 10 } : { opacity: 0, y: 8 }}
                            transition={role === 'assistant'
                              ? { duration: 0.38, ease: [0.16, 1, 0.3, 1] }
                              : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                          >
                            <div className="message-content">
                              {role === 'assistant'
                                ? renderAnimatedAssistantMessage(message.id, message.content || '', customEmojiFiles)
                                : (
                                  <div className="message-markdown">
                                    {renderMarkdownMessage(message.content || '', customEmojiFiles)}
                                  </div>
                                )}
                            </div>
                            {Array.isArray(message.reactions) && message.reactions.length > 0 ? (
                              <div className="message-reactions">
                                {message.reactions.map((reaction, reactionIndex) => (
                                  <div key={`${message.id}-reaction-${reaction}-${reactionIndex}`} className="reaction-chip">
                                    {renderContentWithCustomEmoji(`:${reaction}:`, customEmojiFiles)}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                )}
              </div>

              <form onSubmit={onSendMessage} className={`composer ${messagesForUi.length === 0 ? 'composer-empty' : 'composer-thread'}`}>
                <div className="composer-entry">
                  <textarea
                    ref={composerTextareaRef}
                    rows={1}
                    className="composer-textarea"
                    placeholder={isOnboardingThread ? 'Say something...' : "What's on your mind?"}
                    required
                    value={composerText}
                  disabled={
                    sending ||
                    assistantTalking ||
                    (isOnboardingThread && !['name', 'lana_name', 'personality'].includes(onboardingStep))
                  }
                  onChange={onComposerTextChange}
                  onKeyDown={onComposerKeyDown}
                />
                  <button
                    type="submit"
                    className="primary-btn"
                    disabled={
                      sending ||
                      assistantTalking ||
                      (isOnboardingThread && !['name', 'lana_name', 'personality'].includes(onboardingStep))
                    }
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </section>

        </section>
      )}
    </main>
  );
}
