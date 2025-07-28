import {
	type IDataObject,
	type IExecuteFunctions,
	type ILoadOptionsFunctions,
	type INodeExecutionData,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';
import { makeResolverFromLegacyOptions, NodeVM } from '@n8n/vm2';

import puppeteer from 'puppeteer-extra';
import pluginStealth from 'puppeteer-extra-plugin-stealth';
//@ts-ignore
import pluginHumanTyping from 'puppeteer-extra-plugin-human-typing';
import {
	type Browser,
	type Device,
	KnownDevices as devices,
	type Page,
	type PaperFormat,
	type PDFOptions,
	type PuppeteerLifeCycleEvent,
	type ScreenshotOptions,
} from 'puppeteer';

import { nodeDescription } from './Puppeteer.node.options';

const {
	NODE_FUNCTION_ALLOW_BUILTIN: builtIn,
	NODE_FUNCTION_ALLOW_EXTERNAL: external,
	CODE_ENABLE_STDOUT,
} = process.env;

const CONTAINER_LAUNCH_ARGS = [
	'--no-sandbox',
	'--disable-setuid-sandbox',
	'--disable-dev-shm-usage',
	'--disable-gpu'
];

export const vmResolver = makeResolverFromLegacyOptions({
	external: external ? { modules: external.split(','), transitive: false } : false,
	builtin: builtIn?.split(',') ?? [],
});

interface HeaderObject {
	parameter: Record<string, string>[];
}

interface QueryParameter {
	name: string;
	value: string;
}

interface PuppeteerSessionData {
	wsEndpoint: string;
	pageId: string;
	sessionId: string;
	browserManagerUrl: string;
}

const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.75 Safari/537.36';

async function handleError(
	this: IExecuteFunctions,
	error: Error,
	itemIndex: number,
	url?: string,
	page?: Page,
): Promise<INodeExecutionData> {
	if (page && !page.isClosed()) {
		try {
			await page.close();
		} catch (closeError) {
			console.error(`Puppeteer node: Error closing page during error handling: ${ (closeError as Error).message }`);
		}
	}

	const nodeOperationError = new NodeOperationError(this.getNode(), error, { itemIndex });

	if (this.continueOnFail()) {
		const errorResponse: INodeExecutionData = {
			json: {
				error: nodeOperationError.message,
				stack: nodeOperationError.stack,
			},
			pairedItem: {
				item: itemIndex,
			},
			error: nodeOperationError,
		};
		if (url) errorResponse.json.url = url;
		return errorResponse;
	}

	throw nodeOperationError;
}

async function handleOptions(this: IExecuteFunctions, page: Page): Promise<void> {
	const options = this.getNodeParameter('options', 0, {}) as IDataObject;
	const pageCaching = options.pageCaching !== false;
	const headers: HeaderObject = (options.headers || {}) as HeaderObject;

	const requestHeaders = (headers.parameter || []).reduce((acc: IDataObject, header) => {
		acc[header.name] = header.value;
		return acc;
	}, {});
	const device = options.device as string;

	await page.setCacheEnabled(pageCaching);

	if (device) {
		const emulatedDevice = devices[device as keyof typeof devices] as Device;
		if (emulatedDevice) {
			await page.emulate(emulatedDevice);
		}
	} else {
		const userAgent =
			(requestHeaders['User-Agent'] as string) ||
			(requestHeaders['user-agent'] as string) ||
			DEFAULT_USER_AGENT;
		await page.setUserAgent(userAgent);
	}

	await page.setExtraHTTPHeaders(requestHeaders as Record<string, string>);
}

async function runCustomScript(
	this: IExecuteFunctions,
	itemIndex: number,
	browser: Browser,
	page: Page,
): Promise<INodeExecutionData[]> {
	const scriptCode = this.getNodeParameter('scriptCode', itemIndex) as string;
	const context = {
		$getNodeParameter: this.getNodeParameter.bind(this),
		$getWorkflowStaticData: this.getWorkflowStaticData.bind(this),
		helpers: {
			...this.helpers,
			httpRequestWithAuthentication: this.helpers.httpRequestWithAuthentication.bind(this),
			requestWithAuthenticationPaginated: this.helpers.requestWithAuthenticationPaginated.bind(this),
		},
		...this.getWorkflowDataProxy(itemIndex),
		$browser: browser,
		$page: page,
		$puppeteer: puppeteer,
	};
	const vm = new NodeVM({
		console: 'redirect',
		sandbox: context,
		require: vmResolver,
		wasm: false,
	});

	vm.on(
		'console.log',
		this.getMode() === 'manual'
			? this.sendMessageToUI
			: CODE_ENABLE_STDOUT === 'true'
				? (...args: unknown[]) =>
					console.log(`[Workflow "${this.getWorkflow().id}"][Node "${this.getNode().name}"]`, ...args)
				: () => {},
	);

	try {
		const scriptResult = await vm.run(
			`module.exports = async function() { ${scriptCode}\n}()`,
		);

		if (!Array.isArray(scriptResult)) {
			throw new Error('Custom script must return an array of items. Please ensure your script returns an array, e.g., return [{ key: value }].');
		}

		return this.helpers.normalizeItems(scriptResult);
	} catch (error) {
		// Re-throwing the error to be caught by the main handler
		throw error;
	}
}

async function processPageOperation(
	this: IExecuteFunctions,
	operation: string,
	url: URL,
	page: Page,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const options = this.getNodeParameter('options', 0, {}) as IDataObject;
	const waitUntil = options.waitUntil as PuppeteerLifeCycleEvent;
	const timeout = options.timeout as number;

	const response = await page.goto(url.toString(), {
		waitUntil,
		timeout,
	});

	const headers = await response?.headers();
	const statusCode = response?.status();

	if (!response || (statusCode && statusCode >= 400)) {
		throw new Error(`Request failed with status code ${statusCode || 'unknown'}`);
	}

	const baseJson = {
		headers,
		statusCode,
		url: url.toString(),
	};

	if (operation === 'getPageContent') {
		const body = await page.content();
		return [{
			json: { ...baseJson, body },
			pairedItem: { item: itemIndex },
		}];
	}

	if (operation === 'getScreenshot') {
		const dataPropertyName = this.getNodeParameter('dataPropertyName', itemIndex) as string;
		const fileName = options.fileName as string;
		const type = this.getNodeParameter('imageType', itemIndex) as ScreenshotOptions['type'];
		const fullPage = this.getNodeParameter('fullPage', itemIndex) as boolean;
		const screenshotOptions: ScreenshotOptions = { type, fullPage };

		if (type !== 'png') {
			screenshotOptions.quality = this.getNodeParameter('quality', itemIndex) as number;
		}

		const screenshot = await page.screenshot(screenshotOptions);
		if (screenshot) {
			const binaryData = await this.helpers.prepareBinaryData(
				Buffer.from(screenshot),
				fileName,
				`image/${type}`,
			);
			return [{
				binary: { [dataPropertyName]: binaryData },
				json: baseJson,
				pairedItem: { item: itemIndex },
			}];
		}
	}

	if (operation === 'getPDF') {
		const dataPropertyName = this.getNodeParameter('dataPropertyName', itemIndex) as string;
		const fileName = options.fileName as string;

		const pdfOptions: PDFOptions = {
			pageRanges: this.getNodeParameter('pageRanges', itemIndex) as string,
			displayHeaderFooter: this.getNodeParameter('displayHeaderFooter', itemIndex) as boolean,
			omitBackground: this.getNodeParameter('omitBackground', itemIndex) as boolean,
			printBackground: this.getNodeParameter('printBackground', itemIndex) as boolean,
			landscape: this.getNodeParameter('landscape', itemIndex) as boolean,
			preferCSSPageSize: this.getNodeParameter('preferCSSPageSize', itemIndex) as boolean,
			scale: this.getNodeParameter('scale', itemIndex) as number,
			margin: this.getNodeParameter('margin', itemIndex, {}) as IDataObject,
		};
		if (pdfOptions.displayHeaderFooter) {
			pdfOptions.headerTemplate = this.getNodeParameter('headerTemplate', itemIndex) as string;
			pdfOptions.footerTemplate = this.getNodeParameter('footerTemplate', itemIndex) as string;
		}
		if (!pdfOptions.preferCSSPageSize) {
			pdfOptions.height = this.getNodeParameter('height', itemIndex) as string;
			pdfOptions.width = this.getNodeParameter('width', itemIndex) as string;
			if (!pdfOptions.height && !pdfOptions.width) {
				pdfOptions.format = this.getNodeParameter('format', itemIndex) as PaperFormat;
			}
		}

		const pdf = await page.pdf(pdfOptions);
		if (pdf) {
			const binaryData = await this.helpers.prepareBinaryData(Buffer.from(pdf), fileName, 'application/pdf');
			return [{
				binary: { [dataPropertyName]: binaryData },
				json: baseJson,
				pairedItem: { item: itemIndex },
			}];
		}
	}
	// Fallback for unexpected empty results
	return [];
}


export class Puppeteer implements INodeType {
	description: INodeTypeDescription = nodeDescription;

	methods = {
		loadOptions: {
			async getDevices(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const deviceNames = Object.keys(devices);
				return deviceNames.map(name => {
					const device = devices[name as keyof typeof devices] as Device;
					return {
						name,
						value: name,
						description: `${device.viewport.width} x ${device.viewport.height} @ ${device.viewport.deviceScaleFactor}x`,
					};
				});
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = this.getNodeParameter('operation', 0) as string;

		// --- SESSION MANAGEMENT OPERATIONS ---
		if (operation === 'startPersistentBrowser') {
			const sessionId = this.getNodeParameter('sessionId', 0) as string;
			const browserManagerUrl = this.getNodeParameter('browserManagerUrl', 0) as string;
			try {
				const response = await this.helpers.httpRequest({
					method: 'POST',
					url: `${browserManagerUrl}/start`,
					headers: { 'Content-Type': 'application/json' },
					body: { sessionId },
					json: true,
				}) as IDataObject;
				const sessionData: PuppeteerSessionData = {
					wsEndpoint: response.wsEndpoint as string,
					pageId: response.pageId as string,
					sessionId: response.sessionId as string,
					browserManagerUrl: browserManagerUrl,
				};
				this.getWorkflowStaticData('global').puppeteerSession = sessionData;
				return [this.helpers.returnJsonArray([sessionData as unknown as IDataObject])];
			} catch (error) {
				throw new NodeOperationError(this.getNode(), error as Error, { description: 'Failed to start browser session from manager.' });
			}
		}

		if (operation === 'stopPersistentBrowser') {
			let session = this.getWorkflowStaticData('global').puppeteerSession as PuppeteerSessionData | undefined;
			const sessionId = session?.sessionId ?? this.getNodeParameter('stopSessionId', 0) as string;
			const browserManagerUrl = session?.browserManagerUrl ?? this.getNodeParameter('stopBrowserManagerUrl', 0) as string;

			if (!sessionId || !browserManagerUrl) {
				throw new NodeOperationError(this.getNode(), 'Could not find a session to stop. Provide a fallback Session ID or ensure a Start node ran.');
			}
			try {
				await this.helpers.httpRequest({
					method: 'POST',
					url: `${browserManagerUrl}/stop`,
					headers: { 'Content-Type': 'application/json' },
					body: { sessionId },
					json: true,
				});
				if (session) delete this.getWorkflowStaticData('global').puppeteerSession;
				return [this.helpers.returnJsonArray([{ message: 'Session stopped successfully.' }])];
			} catch (error) {
				throw new NodeOperationError(this.getNode(), error as Error, { description: 'Failed to stop browser session.' });
			}
		}

		// --- ACTION OPERATIONS ---
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const options = this.getNodeParameter('options', 0, {}) as IDataObject;
		const protocolTimeout = options.protocolTimeout as number;

		let session = this.getWorkflowStaticData('global').puppeteerSession as PuppeteerSessionData | undefined;

		if (!session && options.manualSessionOverride === true) {
			const manualWsEndpoint = options.manualWsEndpoint as string;
			const manualPageId = options.manualPageId as string;
			if (!manualWsEndpoint || !manualPageId) throw new NodeOperationError(this.getNode(), 'For Manual Session Override, both WebSocket Endpoint and Page ID are required.');
			session = { wsEndpoint: manualWsEndpoint, pageId: manualPageId, sessionId: 'manual-override', browserManagerUrl: '' };
		}

		let browser: Browser;
		// --- EXECUTION LOGIC: PERSISTENT vs TEMPORARY ---
		if (session) {
			// PERSISTENT BROWSER MODE
			try {
				browser = await puppeteer.connect({ browserWSEndpoint: session.wsEndpoint, protocolTimeout });
				const pages = await browser.pages();
				const page = pages.find(p => (p.target() as any)._targetId === session?.pageId);
				if (!page) {
					throw new NodeOperationError(this.getNode(), `Could not find persistent page with ID '${session.pageId}'. It may have been closed.`);
				}

				for (let i = 0; i < items.length; i++) {
					try {
						await handleOptions.call(this, page);
						let results: INodeExecutionData[];
						if (operation === 'runCustomScript') {
							results = await runCustomScript.call(this, i, browser, page);
						} else {
							const urlString = this.getNodeParameter('url', i) as string;
							const url = new URL(urlString);
							results = await processPageOperation.call(this, operation, url, page, i);
						}
						// Attach session info to the output for chaining
						results.forEach(res => res.json.puppeteerSession = { pageId: session?.pageId, sessionId: session?.sessionId });
						returnData.push(...results);

					} catch (error) {
						returnData.push(await handleError.call(this, error as Error, i, undefined, undefined));
					}
				}
			} catch (error) {
				if (browser! && browser.isConnected()) await browser.disconnect();
				throw new NodeOperationError(this.getNode(), error as Error, { description: 'Failed to execute action in persistent browser.' });
			} finally {
				if (browser! && browser.isConnected()) {
					await browser.disconnect();
				}
			}
		} else {
			// TEMPORARY BROWSER MODE
			const launchOptionsCollection = (options.launchOptions as IDataObject) || {};
			let headless: 'shell' | boolean = launchOptionsCollection.headless !== false;
			if (headless && launchOptionsCollection.shell === true) headless = 'shell';
			if (options.stealth === true) puppeteer.use(pluginStealth());
			if (options.humanTyping === true) puppeteer.use(pluginHumanTyping({ keyboardLayout: 'en', ...((options.humanTypingOptions as IDataObject) || {}) }));

			const launchArgsConfig = (launchOptionsCollection.launchArguments as IDataObject) || {};
			const launchArgsList: IDataObject[] = (launchArgsConfig.args as IDataObject[]) || [];
			const args: string[] = launchArgsList.map((arg: IDataObject) => arg.arg as string);

			if (launchOptionsCollection.addContainerArgs === true) {
				const missing = CONTAINER_LAUNCH_ARGS.filter(arg => !args.includes(arg));
				if(missing.length > 0) args.push(...missing);
			}
			if (options.proxyServer) args.push(`--proxy-server=${options.proxyServer}`);

			try {
				browser = await puppeteer.launch({
					headless,
					args,
					executablePath: launchOptionsCollection.executablePath as string,
					protocolTimeout,
				});
			} catch (error) {
				throw new NodeOperationError(this.getNode(), error as Error, { description: 'Failed to launch temporary browser.' });
			}

			let batchSize = options.batchSize as number;
			if (!Number.isInteger(batchSize) || batchSize < 1) batchSize = 1;

			try {
				for (let i = 0; i < items.length; i += batchSize) {
					const batch = items.slice(i, i + batchSize);
					const promises = batch.map(async (item, idx) => {
						const itemIndex = i + idx;
						let page: Page | undefined;
						try {
							page = await browser.newPage();
							await handleOptions.call(this, page);

							if (operation === 'runCustomScript') {
								return await runCustomScript.call(this, itemIndex, browser, page);
							} else {
								const urlString = this.getNodeParameter('url', itemIndex) as string;
								const queryParametersOptions = this.getNodeParameter('queryParameters', itemIndex, {}) as IDataObject;
								const queryParameters = (queryParametersOptions.parameters as QueryParameter[]) || [];
								const url = new URL(urlString);
								for (const queryParameter of queryParameters) {
									url.searchParams.append(queryParameter.name, queryParameter.value);
								}
								return await processPageOperation.call(this, operation, url, page, itemIndex);
							}
						} catch (error) {
							const url = operation !== 'runCustomScript' ? this.getNodeParameter('url', itemIndex) as string : undefined;
							return await handleError.call(this, error as Error, itemIndex, url, page);
						} finally {
							if (page && !page.isClosed()) await page.close();
						}
					});
					const results = await Promise.all(promises);
					returnData.push(...results.flat());
				}
			} finally {
				if (browser) await browser.close();
			}
		}

		return this.prepareOutputData(returnData);
	}
}
