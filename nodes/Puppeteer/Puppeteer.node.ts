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
	external: external
		? {
				modules: external.split(','),
				transitive: false,
			}
		: false,
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

type ErrorResponse = INodeExecutionData & {
	json: {
		error: string;
		url?: string;
		headers?: HeaderObject;
		statusCode?: number;
		body?: string;
	};
	pairedItem: {
		item: number;
	};
	[key: string]: unknown;
	error: Error;
};

const DEFAULT_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.75 Safari/537.36';

async function handleError(
	this: IExecuteFunctions,
	error: Error,
	itemIndex: number,
	isPersistent: boolean,
	url?: string,
	page?: Page,
): Promise<INodeExecutionData[]> {
	if (page && !page.isClosed() && !isPersistent) {
		try {
			await page.close();
		} catch (closeError) {
			console.error('Error closing page:', closeError);
		}
	}

	if (this.continueOnFail()) {
		const nodeOperationError = new NodeOperationError(this.getNode(), error.message);

		const errorResponse: ErrorResponse = {
			json: {
				error: error.message,
			},
			pairedItem: {
				item: itemIndex,
			},
			error: nodeOperationError,
		};

		if (url) {
			errorResponse.json.url = url;
		}

		return [errorResponse];
	}

	throw new NodeOperationError(this.getNode(), error.message);
}

async function handleOptions(
	this: IExecuteFunctions,
	itemIndex: number,
	items: INodeExecutionData[],
	browser: Browser,
	page: Page,
): Promise<void> {
	const options = this.getNodeParameter('options', 0, {}) as IDataObject;
	const pageCaching = options.pageCaching !== false;
	const headers: HeaderObject = (options.headers || {}) as HeaderObject;

	const requestHeaders = (headers.parameter || []).reduce((acc: any, header: any) => {
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
			requestHeaders['User-Agent'] ||
			requestHeaders['user-agent'] ||
			DEFAULT_USER_AGENT;
		await page.setUserAgent(userAgent);
	}

	await page.setExtraHTTPHeaders(requestHeaders);
}

async function runCustomScript(
	this: IExecuteFunctions,
	itemIndex: number,
	items: INodeExecutionData[],
	browser: Browser,
	page: Page,
	isPersistent: boolean,
): Promise<INodeExecutionData[]> {
	const scriptCode = this.getNodeParameter('scriptCode', itemIndex) as string;
	const context = {
		$getNodeParameter: this.getNodeParameter,
		$getWorkflowStaticData: this.getWorkflowStaticData,
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
			return handleError.call(
				this,
				new Error(
					'Custom script must return an array of items. Please ensure your script returns an array, e.g., return [{ key: value }].',
				),
				itemIndex,
				isPersistent,
				undefined,
				page,
			);
		}

		return this.helpers.normalizeItems(scriptResult);
	} catch (error) {
		return handleError.call(this, error as Error, itemIndex, isPersistent, undefined, page);
	}
}

async function processPageOperation(
	this: IExecuteFunctions,
	operation: string,
	url: URL,
	page: Page,
	itemIndex: number,
	options: IDataObject,
	isPersistent: boolean,
): Promise<INodeExecutionData[]> {
	const waitUntil = options.waitUntil as PuppeteerLifeCycleEvent;
	const timeout = options.timeout as number;

	try {
		const response = await page.goto(url.toString(), {
			waitUntil,
			timeout,
		});

		const headers = await response?.headers();
		const statusCode = response?.status();

		if (!response || (statusCode && statusCode >= 400)) {
			return handleError.call(
				this,
				new Error(`Request failed with status code ${statusCode || 0}`),
				itemIndex,
				isPersistent,
				url.toString(),
				page,
			);
		}

		if (operation === 'getPageContent') {
			const body = await page.content();
			return [{
				json: {
					body,
					headers,
					statusCode,
					url: url.toString(),
				},
				pairedItem: {
					item: itemIndex,
				},
			}];
		}

		if (operation === 'getScreenshot') {
			try {
				const dataPropertyName = this.getNodeParameter(
					'dataPropertyName',
					itemIndex,
				) as string;
				const fileName = options.fileName as string;
				const type = this.getNodeParameter(
					'imageType',
					itemIndex,
				) as ScreenshotOptions['type'];
				const fullPage = this.getNodeParameter(
					'fullPage',
					itemIndex,
				) as boolean;
				const screenshotOptions: ScreenshotOptions = {
					type,
					fullPage,
				};

				if (type !== 'png') {
					const quality = this.getNodeParameter(
						'quality',
						itemIndex,
					) as number;
					screenshotOptions.quality = quality;
				}

				if (fileName) {
					screenshotOptions.path = fileName;
				}

				const screenshot = await page.screenshot(screenshotOptions);
				if (screenshot) {
					const binaryData = await this.helpers.prepareBinaryData(
						Buffer.from(screenshot),
						screenshotOptions.path,
						`image/${type}`,
					);
					return [{
						binary: { [dataPropertyName]: binaryData },
						json: {
							headers,
							statusCode,
							url: url.toString(),
						},
						pairedItem: {
							item: itemIndex,
						},
					}];
				}
			} catch (error) {
				return handleError.call(this, error as Error, itemIndex, isPersistent, url.toString(), page);
			}
		}

		if (operation === 'getPDF') {
			try {
				const dataPropertyName = this.getNodeParameter(
					'dataPropertyName',
					itemIndex,
				) as string;
				const pageRanges = this.getNodeParameter(
					'pageRanges',
					itemIndex,
				) as string;
				const displayHeaderFooter = this.getNodeParameter(
					'displayHeaderFooter',
					itemIndex,
				) as boolean;
				const omitBackground = this.getNodeParameter(
					'omitBackground',
					itemIndex,
				) as boolean;
				const printBackground = this.getNodeParameter(
					'printBackground',
					itemIndex,
				) as boolean;
				const landscape = this.getNodeParameter(
					'landscape',
					itemIndex,
				) as boolean;
				const preferCSSPageSize = this.getNodeParameter(
					'preferCSSPageSize',
					itemIndex,
				) as boolean;
				const scale = this.getNodeParameter('scale', itemIndex) as number;
				const margin = this.getNodeParameter(
					'margin',
					0,
					{},
				) as IDataObject;

				let headerTemplate = '';
				let footerTemplate = '';
				let height = '';
				let width = '';
				let format: PaperFormat = 'A4';

				if (displayHeaderFooter === true) {
					headerTemplate = this.getNodeParameter(
						'headerTemplate',
						itemIndex,
					) as string;
					footerTemplate = this.getNodeParameter(
						'footerTemplate',
						itemIndex,
					) as string;
				}

				if (preferCSSPageSize !== true) {
					height = this.getNodeParameter('height', itemIndex) as string;
					width = this.getNodeParameter('width', itemIndex) as string;

					if (!height || !width) {
						format = this.getNodeParameter(
							'format',
							itemIndex,
						) as PaperFormat;
					}
				}

				const pdfOptions: PDFOptions = {
					format,
					displayHeaderFooter,
					omitBackground,
					printBackground,
					landscape,
					headerTemplate,
					footerTemplate,
					preferCSSPageSize,
					scale,
					height,
					width,
					pageRanges,
					margin,
				};
				const fileName = options.fileName as string;
				if (fileName) {
					pdfOptions.path = fileName;
				}

				const pdf = await page.pdf(pdfOptions);
				if (pdf) {
					const binaryData = await this.helpers.prepareBinaryData(
						Buffer.from(pdf),
						pdfOptions.path,
						'application/pdf',
					);
					return [{
						binary: { [dataPropertyName]: binaryData },
						json: {
							headers,
							statusCode,
							url: url.toString(),
						},
						pairedItem: {
							item: itemIndex,
						},
					}];
				}
			} catch (error) {
				return handleError.call(this, error as Error, itemIndex, isPersistent, url.toString(), page);
			}
		}

		return handleError.call(
			this,
			new Error(`Unsupported operation: ${operation}`),
			itemIndex,
			isPersistent,
			url.toString(),
			page,
		);
	} catch (error) {
		return handleError.call(this, error as Error, itemIndex, isPersistent, url.toString(), page);
	}
	// Fallback return added to satisfy TypeScript, though logic paths should always return inside the try block.
	return [];
}

export class Puppeteer implements INodeType {
	description: INodeTypeDescription = nodeDescription;

	methods = {
		loadOptions: {
			async getDevices(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				const deviceNames = Object.keys(devices);
				const returnData: INodePropertyOptions[] = [];

				for (const name of deviceNames) {
					const device = devices[name as keyof typeof devices] as Device;
					returnData.push({
						name,
						value: name,
						description: `${device.viewport.width} x ${device.viewport.height} @ ${device.viewport.deviceScaleFactor}x`,
					});
				}

				return returnData;
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = this.getNodeParameter('operation', 0) as string;

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

		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const options = this.getNodeParameter('options', 0, {}) as IDataObject;
		let session = this.getWorkflowStaticData('global').puppeteerSession as PuppeteerSessionData | undefined;
		let isPersistent = !!session;

		if (!session && options.manualSessionOverride === true) {
			const manualWsEndpoint = options.manualWsEndpoint as string;
			const manualPageId = options.manualPageId as string;
			if(!manualWsEndpoint || !manualPageId) throw new NodeOperationError(this.getNode(), 'For Manual Session Override, both WebSocket Endpoint and Page ID are required.');
			session = { wsEndpoint: manualWsEndpoint, pageId: manualPageId, sessionId: 'manual-override', browserManagerUrl: '' };
			isPersistent = true;
		}

		if (session) {
			const protocolTimeout = options.protocolTimeout as number;
			let browser: Browser;
			try {
				browser = await puppeteer.connect({ browserWSEndpoint: session.wsEndpoint, protocolTimeout });
				const page = (await browser.pages()).find(p => (p.target() as any)._targetId === session.pageId);

				if (!page) {
					throw new NodeOperationError(this.getNode(), `Could not find persistent page with ID '${session.pageId}'.`);
				}

				for (let i = 0; i < items.length; i++) {
					await handleOptions.call(this, i, items, browser, page);

					if (operation === 'runCustomScript') {
						returnData.push(...await runCustomScript.call(this, i, items, browser, page, isPersistent));
					} else {
						const urlString = this.getNodeParameter('url', i) as string;
						const url = new URL(urlString);
						returnData.push(...await processPageOperation.call(this, operation, url, page, i, options, isPersistent));
					}
				}
			} catch(error) {
				throw new NodeOperationError(this.getNode(), error as Error, { description: 'Failed to execute action in persistent browser.' });
			} finally {
				if (browser! && browser.isConnected()) {
					await browser.disconnect();
				}
			}
			return this.prepareOutputData(returnData);
		} else {
			// TEMPORARY MODE (ORIGINAL LOGIC)
			let headless: 'shell' | boolean = options.headless !== false;
			const headlessShell = options.shell === true;
			const executablePath = options.executablePath as string;
			const browserWSEndpoint = options.browserWSEndpoint as string;
			const stealth = options.stealth === true;
			const humanTyping = options.humanTyping === true;
			const humanTypingOptions =  {
				keyboardLayout: "en",
				...((options.humanTypingOptions as IDataObject) || {})
			};
			const launchArguments = (options.launchArguments as IDataObject) || {};
			const launchArgs: IDataObject[] = launchArguments.args as IDataObject[];
			const args: string[] = [];
			const device = options.device as string;
			const protocolTimeout = options.protocolTimeout as number;
			let batchSize = options.batchSize as number;

			if (!Number.isInteger(batchSize) || batchSize < 1) {
				batchSize = 1;
			}

			if (launchArgs && launchArgs.length > 0) {
				args.push(...launchArgs.map((arg: IDataObject) => arg.arg as string));
			}

			const addContainerArgs = options.addContainerArgs === true;
			if (addContainerArgs) {
				const missingContainerArgs = CONTAINER_LAUNCH_ARGS.filter(arg => !args.some(
					existingArg => existingArg === arg || existingArg.startsWith(`${arg}=`)
				));

				if (missingContainerArgs.length > 0) {
					console.log('Puppeteer node: Adding container optimizations:', missingContainerArgs);
					args.push(...missingContainerArgs);
				} else {
					console.log('Puppeteer node: Container optimizations already present in launch arguments');
				}
			}

			if (options.proxyServer) {
				args.push(`--proxy-server=${options.proxyServer}`);
			}

			if (stealth) {
				puppeteer.use(pluginStealth());
			}
			if (humanTyping) {
				puppeteer.use(pluginHumanTyping(humanTypingOptions));
			}

			if (headless && headlessShell) {
				headless = 'shell';
			}

			let browser: Browser;
			try {
				if (browserWSEndpoint) {
					browser = await puppeteer.connect({
						browserWSEndpoint,
						protocolTimeout,
					});
				} else {
					browser = await puppeteer.launch({
						headless,
						args,
						executablePath,
						protocolTimeout,
					});
				}
			} catch (error) {
				throw new Error(`Failed to launch/connect to browser: ${(error as Error).message}`);
			}

			const processItem = async (
				item: INodeExecutionData,
				itemIndex: number,
			): Promise<INodeExecutionData[]> => {
				let page: Page | undefined;
				try {
					page = await browser.newPage();
					await handleOptions.call(this, itemIndex, items, browser, page);

					if (operation === 'runCustomScript') {
						console.log(
							`Processing ${itemIndex + 1} of ${items.length}: [${operation}]${device ? ` [${device}] ` : ' '} Custom Script`,
						);
						return await runCustomScript.call(
							this,
							itemIndex,
							items,
							browser,
							page,
							isPersistent,
						);
					}
						const urlString = this.getNodeParameter('url', itemIndex) as string;
						const queryParametersOptions = this.getNodeParameter(
							'queryParameters',
							itemIndex,
							{},
						) as IDataObject;

						const queryParameters = (queryParametersOptions.parameters as QueryParameter[]) || [];
						let url: URL;

						try {
							url = new URL(urlString);
							for (const queryParameter of queryParameters) {
								url.searchParams.append(queryParameter.name, queryParameter.value);
							}
						} catch (error) {
							return handleError.call(
								this,
								new Error(`Invalid URL: ${urlString}`),
								itemIndex,
								isPersistent,
								urlString,
								page,
							);
						}

						console.log(
							`Processing ${itemIndex + 1} of ${items.length}: [${operation}]${device ? ` [${device}] ` : ' '}${url}`,
						);

						return await processPageOperation.call(
							this,
							operation,
							url,
							page,
							itemIndex,
							options,
							isPersistent,
						);
				} catch (error) {
					return handleError.call(
						this,
						error as Error,
						itemIndex,
						isPersistent,
						undefined,
						page,
					);
				} finally {
					if (page) {
						try {
							await page.close();
						} catch (error) {
							console.error('Error closing page:', error);
						}
					}
				}
			};

			try {
				for (let i = 0; i < items.length; i += batchSize) {
					const batch = items.slice(i, i + batchSize);
					const results = await Promise.all(
						batch.map((item, idx) => processItem(item, i + idx)),
					);
					if (results?.length) {
						returnData.push(...results.flat());
					}
				}
			} finally {
				if (browser) {
					try {
						if (browserWSEndpoint) {
							await browser.disconnect();
						} else {
							await browser.close();
						}
					} catch (error) {
						console.error('Error closing browser:', error);
					}
				}
			}

			return this.prepareOutputData(returnData);
		}
	}
}
