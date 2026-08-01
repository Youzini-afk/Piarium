import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const gitService = {
  stageGitFiles: mock(),
  unstageGitFiles: mock(),
  getGitRangeFiles: mock(),
  getGitRangeDiff: mock(),
};

const sdkClient = {
  v2: {
    model: {
      list: mock(),
    },
  },
  session: {
    create: mock(),
    promptAsync: mock(),
    messages: mock(),
    delete: mock(),
  },
};

const createOpencodeClient = mock(() => sdkClient);
const originalFetch = globalThis.fetch;
const rawFetch = mock(async () => {
  throw new Error('raw fetch should not be used');
});

const sdkStyleResponse = async (fetchImpl, url, init) => {
  const response = await fetchImpl(new Request(url, init));
  return { data: await response.json().catch(() => true), error: undefined, response };
};

const createRuntimeFetchCompatibleClient = (config = {}) => {
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
  const fetchImpl = config.fetch || globalThis.fetch;
  const withDirectory = (url, directory) => directory ? `${url}?directory=${encodeURIComponent(directory)}` : url;
  const jsonRequest = (method, url, body) => sdkStyleResponse(fetchImpl, url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    v2: {
      session: {
        prompt: (params) => jsonRequest('POST', withDirectory(`${baseUrl}/api/session/${params.sessionID}/prompt`, params.directory), {
          prompt: params.prompt,
          delivery: params.delivery,
        }),
      },
      model: { list: sdkClient.v2.model.list },
    },
    session: {
      create: sdkClient.session.create,
      promptAsync: sdkClient.session.promptAsync,
      messages: sdkClient.session.messages,
      delete: sdkClient.session.delete,
      shell: (params) => jsonRequest('POST', withDirectory(`${baseUrl}/session/${params.sessionID}/shell`, params.directory), {
        messageID: params.messageID,
        agent: params.agent,
        model: params.model,
        command: params.command,
      }),
      update: (params) => jsonRequest('PATCH', withDirectory(`${baseUrl}/session/${params.sessionID}`, params.directory), {
        title: params.title,
        permission: params.permission,
        time: params.time,
      }),
    },
    permission: {
      reply: (params) => jsonRequest('POST', withDirectory(`${baseUrl}/permission/${params.requestID}/reply`, params.directory), { reply: params.reply }),
    },
    question: {
      reply: (params) => jsonRequest('POST', withDirectory(`${baseUrl}/question/${params.requestID}/reply`, params.directory), { answers: params.answers }),
    },
    auth: {
      set: (params) => jsonRequest('PUT', `${baseUrl}/auth/${params.providerID}`, params.auth),
    },
    provider: {
      oauth: {
        callback: (params) => jsonRequest('POST', `${baseUrl}/provider/${params.providerID}/oauth/callback`, {
          method: params.method,
          code: params.code,
        }),
      },
    },
  };
};

mock.module('./gitService', () => gitService);
mock.module('@opencode-ai/sdk/v2', () => ({ createOpencodeClient }));

const { handleSpecialGitBridgeMessage } = await import('./bridge-git-special-runtime');

describe('bridge git special runtime', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    createOpencodeClient.mockImplementation(createRuntimeFetchCompatibleClient);
  });

  beforeEach(() => {
    gitService.stageGitFiles.mockReset();
    gitService.unstageGitFiles.mockReset();
    gitService.getGitRangeFiles.mockReset();
    gitService.getGitRangeDiff.mockReset();
    sdkClient.v2.model.list.mockReset();
    sdkClient.session.create.mockReset();
    sdkClient.session.promptAsync.mockReset();
    sdkClient.session.messages.mockReset();
    sdkClient.session.delete.mockReset();
    createOpencodeClient.mockReset();
    rawFetch.mockClear();

    globalThis.fetch = rawFetch;
    createOpencodeClient.mockImplementation(() => sdkClient);
    gitService.getGitRangeFiles.mockImplementation(async () => ['src/a.ts']);
    gitService.getGitRangeDiff.mockImplementation(async () => ({ diff: 'diff --git a/src/a.ts b/src/a.ts\n+new line' }));
    sdkClient.v2.model.list.mockImplementation(async () => ({
      data: [{ providerID: 'anthropic', id: 'claude-sonnet-4-5' }],
      error: undefined,
    }));
    sdkClient.session.create.mockImplementation(async () => ({
      data: { id: 'ses_1' },
      error: undefined,
    }));
    sdkClient.session.promptAsync.mockImplementation(async () => ({ data: true, error: undefined }));
    sdkClient.session.messages.mockImplementation(async () => ({
      data: [{
        info: { role: 'assistant', finish: 'stop' },
        parts: [{ type: 'text', text: '{"title":"PR title","body":"PR body"}' }],
      }],
      error: undefined,
    }));
    sdkClient.session.delete.mockImplementation(async () => ({ data: true, error: undefined }));
  });

  it('generates PR descriptions through the OpenCode SDK session flow', async () => {
    const response = await handleSpecialGitBridgeMessage({
      id: '1',
      type: 'api:git/pr-description',
      payload: {
        directory: '/repo',
        base: 'main',
        head: 'feature',
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-5',
      },
    }, {
      manager: {
        getApiUrl: () => 'http://opencode.test',
        getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
      },
    }, {
      readSettings: () => ({}),
      execGit: mock(),
    });

    expect(response).toEqual({
      id: '1',
      type: 'api:git/pr-description',
      success: true,
      data: { title: 'PR title', body: 'PR body' },
    });
    expect(rawFetch).not.toHaveBeenCalled();
    expect(createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: 'http://opencode.test',
      headers: { Authorization: 'Bearer test' },
    });
    expect(sdkClient.v2.model.list).toHaveBeenCalled();
    expect(sdkClient.session.create).toHaveBeenCalledWith({
      directory: '/repo',
      title: 'Git Generation',
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sdkClient.session.promptAsync).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: 'ses_1',
      directory: '/repo',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sdkClient.session.messages).toHaveBeenCalledWith({
      sessionID: 'ses_1',
      directory: '/repo',
      limit: 10,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(sdkClient.session.delete).toHaveBeenCalledWith({ sessionID: 'ses_1' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
