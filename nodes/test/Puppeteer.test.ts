jest.mock('puppeteer-extra', () => ({
  launch: jest.fn().mockResolvedValue({
    newPage: jest.fn().mockResolvedValue({
      goto: jest.fn().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
      content: jest.fn().mockResolvedValue('<html><body>Test Content</body></html>'),
      screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-screenshot-data')),
      pdf: jest.fn().mockResolvedValue(Buffer.from('fake-pdf-data')),
      close: jest.fn(),
      isClosed: jest.fn().mockReturnValue(false),
      setViewport: jest.fn(),
      setExtraHTTPHeaders: jest.fn(),
      setCacheEnabled: jest.fn(),
      emulate: jest.fn(),
      setUserAgent: jest.fn(),
      target: jest.fn().mockReturnValue({ _targetId: 'test-page-id' }),
    }),
    close: jest.fn(),
    isConnected: jest.fn().mockReturnValue(true),
  }),
  connect: jest.fn().mockResolvedValue({
    disconnect: jest.fn(),
    isConnected: jest.fn().mockReturnValue(true),
    pages: jest.fn().mockResolvedValue([{
      target: () => ({ _targetId: 'test-page-id' }),
      content: jest.fn().mockResolvedValue('<html><body>Persistent Content</body></html>'),
      setUserAgent: jest.fn(),
      setExtraHTTPHeaders: jest.fn(),
      setCacheEnabled: jest.fn(),
      emulate: jest.fn(),
      goto: jest.fn().mockResolvedValue({ status: () => 200, headers: () => ({}) }),
    }]),
  }),
}));

// Mock @n8n/vm2
jest.mock('@n8n/vm2', () => ({
  makeResolverFromLegacyOptions: jest.fn().mockReturnValue({}),
  NodeVM: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    run: jest.fn().mockResolvedValue([{ json: { result: "test success" } }]),
  })),
}));

import { IExecuteFunctions } from 'n8n-workflow';
import { Puppeteer } from '../Puppeteer/Puppeteer.node';

describe('Puppeteer Node', () => {
  let nodeInstance: Puppeteer;
  let mockStaticData: { global: Record<string, any> };

  beforeEach(() => {
    nodeInstance = new Puppeteer();
    mockStaticData = { global: {} };
    jest.clearAllMocks();
  });

  const createMockExecuteFunctions = (params: Record<string, any>): IExecuteFunctions => {
    return {
      getInputData: () => [{ json: {} }],
      getNodeParameter: jest.fn((parameterName: string, itemIndex: number, fallback?: any) => {
        return params[parameterName] ?? fallback;
      }),
      helpers: {
        httpRequest: jest.fn(),
        returnJsonArray: (items: any[]) => items.map(item => ({ json: item })),
        prepareBinaryData: jest.fn().mockImplementation((data, fileName, mimeType) => ({
          data: data.toString('base64'), fileName, mimeType,
        })),
        normalizeItems: (items: any) => (Array.isArray(items) ? items : [items]),
        httpRequestWithAuthentication: jest.fn(),
        requestWithAuthenticationPaginated: jest.fn(),
      },
      continueOnFail: () => false,
      getNode: () => ({
        id: 'test', name: 'test', type: 'puppeteer', typeVersion: 1,
        position: [0, 0], parameters: {}
      }),
      getWorkflowStaticData: (type: string) => {
        if (type === 'global') {
          return mockStaticData.global;
        }
        return {};
      },
      prepareOutputData: jest.fn().mockImplementation((data) => Promise.resolve([data])),
      getWorkflowDataProxy: jest.fn().mockReturnValue({ $json: {} }),
      getMode: () => 'manual',
    } as unknown as IExecuteFunctions;
  };

  describe('Temporary Browser Mode (Original Functionality)', () => {
    it('should handle getPageContent operation', async () => {
      const mockExecuteFunctions = createMockExecuteFunctions({
        'operation': 'getPageContent', 'url': 'https://example.com', 'options': {},
      });
      const result = await nodeInstance.execute.call(mockExecuteFunctions);
      expect(require('puppeteer-extra').launch).toHaveBeenCalled();
      expect(result[0][0].json).toHaveProperty('body', '<html><body>Test Content</body></html>');
    });

    it('should handle getScreenshot operation', async () => {
        const mockExecuteFunctions = createMockExecuteFunctions({
            'operation': 'getScreenshot', 'url': 'https://example.com', 'options': {}, 'dataPropertyName': 'screenshot', 'imageType': 'png'
        });
        const result = await nodeInstance.execute.call(mockExecuteFunctions);
        expect(result[0][0]).toHaveProperty('binary');
        expect(result[0][0].binary?.screenshot).toBeDefined();
    });

    it('should handle runCustomScript operation', async () => {
        const mockExecuteFunctions = createMockExecuteFunctions({
            'operation': 'runCustomScript', 'scriptCode': 'return true;', 'options': {},
        });
        const result = await nodeInstance.execute.call(mockExecuteFunctions);
        expect(result[0][0].json).toHaveProperty('result', 'test success');
    });
  });

  describe('Persistent Browser Mode (New Functionality)', () => {
    const MOCK_SESSION = {
      sessionId: 'persistent-session-123',
      pageId: 'test-page-id',
      wsEndpoint: 'ws://localhost:9222/browser/xyz',
      browserManagerUrl: 'http://localhost:3001',
    };

    it('should start a persistent session', async () => {
        const mockExecuteFunctions = createMockExecuteFunctions({
            'operation': 'startPersistentBrowser', 'sessionId': MOCK_SESSION.sessionId, 'browserManagerUrl': MOCK_SESSION.browserManagerUrl,
        });
        (mockExecuteFunctions.helpers.httpRequest as jest.Mock).mockResolvedValue(MOCK_SESSION);

        const result = await nodeInstance.execute.call(mockExecuteFunctions);

        expect(mockStaticData.global.puppeteerSession).toEqual(MOCK_SESSION);
        expect(result[0][0].json).toEqual(MOCK_SESSION);
    });

    it('should use a persistent session to run a custom script', async () => {
        mockStaticData.global.puppeteerSession = MOCK_SESSION; // Simulate session exists
        const mockExecuteFunctions = createMockExecuteFunctions({
            'operation': 'runCustomScript', 'scriptCode': 'return true;', 'options': {},
        });

        const result = await nodeInstance.execute.call(mockExecuteFunctions);

        const puppeteer = require('puppeteer-extra');
        expect(puppeteer.connect).toHaveBeenCalledWith(expect.objectContaining({ browserWSEndpoint: MOCK_SESSION.wsEndpoint }));
        expect(puppeteer.launch).not.toHaveBeenCalled();
        expect(result[0][0].json).toHaveProperty('result', 'test success');
    });

    it('should reuse the same session across multiple, different operations', async () => {
        mockStaticData.global.puppeteerSession = MOCK_SESSION;
        const mockExecuteFunctions = createMockExecuteFunctions({
            'operation': 'getPageContent', 'url': 'https://example.com', 'options': {},
        });

        // Run the first operation
        await nodeInstance.execute.call(mockExecuteFunctions);
        const puppeteer = require('puppeteer-extra');
        expect(puppeteer.connect).toHaveBeenCalledTimes(1);
        expect(puppeteer.launch).not.toHaveBeenCalled();

        // Change parameters for the second operation
        (mockExecuteFunctions.getNodeParameter as jest.Mock).mockImplementation((name: string) => {
            const params = { 'operation': 'runCustomScript', 'scriptCode': 'return true;', 'options': {} };
            return (params as any)[name];
        });

        // Run the second operation
        await nodeInstance.execute.call(mockExecuteFunctions);

        expect(puppeteer.connect).toHaveBeenCalledTimes(2);
        expect(puppeteer.launch).not.toHaveBeenCalled();
    });

    it('should stop a persistent session', async () => {
        mockStaticData.global.puppeteerSession = MOCK_SESSION; // Simulate session exists
        const mockExecuteFunctions = createMockExecuteFunctions({ 'operation': 'stopPersistentBrowser' });
        (mockExecuteFunctions.helpers.httpRequest as jest.Mock).mockResolvedValue({});

        await nodeInstance.execute.call(mockExecuteFunctions);

        expect(mockExecuteFunctions.helpers.httpRequest).toHaveBeenCalledWith(expect.objectContaining({
            body: { sessionId: MOCK_SESSION.sessionId },
        }));
        expect(mockStaticData.global.puppeteerSession).toBeUndefined();
    });
  });
});
