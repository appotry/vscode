/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getPixelRatio, getZoomLevel } from 'vs/base/browser/browser';
import { Emitter, Event } from 'vs/base/common/event';
import * as glob from 'vs/base/common/glob';
import { Iterable } from 'vs/base/common/iterator';
import { Lazy } from 'vs/base/common/lazy';
import { Disposable, DisposableStore, IDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { ResourceMap } from 'vs/base/common/map';
import { Schemas } from 'vs/base/common/network';
import { isDefined } from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { BareFontInfo } from 'vs/editor/common/config/fontInfo';
import { IAccessibilityService } from 'vs/platform/accessibility/common/accessibility';
import { ConfigurationTarget, IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IResourceEditorInput } from 'vs/platform/editor/common/editor';
import { IFileService } from 'vs/platform/files/common/files';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { IWorkspaceTrustManagementService } from 'vs/platform/workspace/common/workspaceTrust';
import { NotebookExtensionDescription } from 'vs/workbench/api/common/extHost.protocol';
import { Memento } from 'vs/workbench/common/memento';
import { INotebookEditorContribution, notebookRendererExtensionPoint, notebooksExtensionPoint } from 'vs/workbench/contrib/notebook/browser/extensionPoint';
import { INotebookEditorOptions } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { NotebookDiffEditorInput } from 'vs/workbench/contrib/notebook/browser/notebookDiffEditorInput';
import { NotebookCellTextModel } from 'vs/workbench/contrib/notebook/common/model/notebookCellTextModel';
import { NotebookTextModel } from 'vs/workbench/contrib/notebook/common/model/notebookTextModel';
import { ACCESSIBLE_NOTEBOOK_DISPLAY_ORDER, BUILTIN_RENDERER_ID, CellUri, NotebookSetting, INotebookContributionData, INotebookExclusiveDocumentFilter, INotebookRendererInfo, INotebookTextModel, IOrderedMimeType, IOutputDto, MimeTypeDisplayOrder, mimeTypeIsAlwaysSecure, mimeTypeSupportedByCore, NotebookData, NotebookEditorPriority, NotebookRendererMatch, NOTEBOOK_DISPLAY_ORDER, RENDERER_EQUIVALENT_EXTENSIONS, RENDERER_NOT_AVAILABLE, TransientOptions } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { NotebookEditorInput } from 'vs/workbench/contrib/notebook/common/notebookEditorInput';
import { INotebookEditorModelResolverService } from 'vs/workbench/contrib/notebook/common/notebookEditorModelResolverService';
import { updateEditorTopPadding } from 'vs/workbench/contrib/notebook/common/notebookOptions';
import { NotebookOutputRendererInfo } from 'vs/workbench/contrib/notebook/common/notebookOutputRenderer';
import { NotebookEditorDescriptor, NotebookProviderInfo } from 'vs/workbench/contrib/notebook/common/notebookProvider';
import { ComplexNotebookProviderInfo, INotebookContentProvider, INotebookSerializer, INotebookService, SimpleNotebookProviderInfo } from 'vs/workbench/contrib/notebook/common/notebookService';
import { DiffEditorInputFactoryFunction, EditorInputFactoryFunction, IEditorResolverService, IEditorType, RegisteredEditorInfo, RegisteredEditorPriority, UntitledEditorInputFactoryFunction } from 'vs/workbench/services/editor/common/editorResolverService';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IExtensionPointUser } from 'vs/workbench/services/extensions/common/extensionsRegistry';

export class NotebookProviderInfoStore extends Disposable {

	private static readonly CUSTOM_EDITORS_STORAGE_ID = 'notebookEditors';
	private static readonly CUSTOM_EDITORS_ENTRY_ID = 'editors';

	private readonly _memento: Memento;
	private _handled: boolean = false;

	private readonly _contributedEditors = new Map<string, NotebookProviderInfo>();
	private readonly _contributedEditorDisposables = this._register(new DisposableStore());

	constructor(
		@IStorageService storageService: IStorageService,
		@IExtensionService extensionService: IExtensionService,
		@IEditorResolverService private readonly _editorResolverService: IEditorResolverService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IAccessibilityService private readonly _accessibilityService: IAccessibilityService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IFileService private readonly _fileService: IFileService,
		@INotebookEditorModelResolverService private readonly _notebookEditorModelResolverService: INotebookEditorModelResolverService
	) {
		super();
		this._memento = new Memento(NotebookProviderInfoStore.CUSTOM_EDITORS_STORAGE_ID, storageService);

		const mementoObject = this._memento.getMemento(StorageScope.GLOBAL, StorageTarget.MACHINE);
		for (const info of (mementoObject[NotebookProviderInfoStore.CUSTOM_EDITORS_ENTRY_ID] || []) as NotebookEditorDescriptor[]) {
			this.add(new NotebookProviderInfo(info));
		}

		this._register(extensionService.onDidRegisterExtensions(() => {
			if (!this._handled) {
				// there is no extension point registered for notebook content provider
				// clear the memento and cache
				this._clear();
				mementoObject[NotebookProviderInfoStore.CUSTOM_EDITORS_ENTRY_ID] = [];
				this._memento.saveMemento();
			}
		}));

		notebooksExtensionPoint.setHandler(extensions => this._setupHandler(extensions));
	}

	override dispose(): void {
		this._clear();
		super.dispose();
	}

	private _setupHandler(extensions: readonly IExtensionPointUser<INotebookEditorContribution[]>[]) {
		this._handled = true;
		const builtins: NotebookProviderInfo[] = [...this._contributedEditors.values()].filter(info => !info.extension);
		this._clear();

		const builtinProvidersFromCache: Map<string, IDisposable> = new Map();
		builtins.forEach(builtin => {
			builtinProvidersFromCache.set(builtin.id, this.add(builtin));
		});

		for (const extension of extensions) {
			for (const notebookContribution of extension.value) {

				if (!notebookContribution.type) {
					extension.collector.error(`Notebook does not specify type-property`);
					continue;
				}

				const existing = this.get(notebookContribution.type);

				if (existing) {
					if (!existing.extension && extension.description.isBuiltin && builtins.find(builtin => builtin.id === notebookContribution.type)) {
						// we are registering an extension which is using the same view type which is already cached
						builtinProvidersFromCache.get(notebookContribution.type)?.dispose();
					} else {
						extension.collector.error(`Notebook type '${notebookContribution.type}' already used`);
						continue;
					}
				}

				this.add(new NotebookProviderInfo({
					extension: extension.description.identifier,
					id: notebookContribution.type,
					displayName: notebookContribution.displayName,
					selectors: notebookContribution.selector || [],
					priority: this._convertPriority(notebookContribution.priority),
					providerDisplayName: extension.description.displayName ?? extension.description.identifier.value,
					exclusive: false
				}));
			}
		}

		const mementoObject = this._memento.getMemento(StorageScope.GLOBAL, StorageTarget.MACHINE);
		mementoObject[NotebookProviderInfoStore.CUSTOM_EDITORS_ENTRY_ID] = Array.from(this._contributedEditors.values());
		this._memento.saveMemento();
	}

	private _convertPriority(priority?: string) {
		if (!priority) {
			return RegisteredEditorPriority.default;
		}

		if (priority === NotebookEditorPriority.default) {
			return RegisteredEditorPriority.default;
		}

		return RegisteredEditorPriority.option;

	}

	private _registerContributionPoint(notebookProviderInfo: NotebookProviderInfo): IDisposable {

		const disposables = new DisposableStore();

		for (const selector of notebookProviderInfo.selectors) {
			const globPattern = (selector as INotebookExclusiveDocumentFilter).include || selector as glob.IRelativePattern | string;
			const notebookEditorInfo: RegisteredEditorInfo = {
				id: notebookProviderInfo.id,
				label: notebookProviderInfo.displayName,
				detail: notebookProviderInfo.providerDisplayName,
				priority: notebookProviderInfo.exclusive ? RegisteredEditorPriority.exclusive : notebookProviderInfo.priority,
			};
			const notebookEditorOptions = {
				canHandleDiff: () => !!this._configurationService.getValue(NotebookSetting.textDiffEditorPreview) && !this._accessibilityService.isScreenReaderOptimized(),
				canSupportResource: (resource: URI) => resource.scheme === Schemas.untitled || resource.scheme === Schemas.vscodeNotebookCell || this._fileService.hasProvider(resource)
			};
			const notebookEditorInputFactory: EditorInputFactoryFunction = ({ resource, options }) => {
				const data = CellUri.parse(resource);
				let notebookUri: URI = resource;
				let cellOptions: IResourceEditorInput | undefined;

				if (data) {
					notebookUri = data.notebook;
					cellOptions = { resource, options };
				}

				const notebookOptions = { ...options, cellOptions } as INotebookEditorOptions;
				return { editor: NotebookEditorInput.create(this._instantiationService, notebookUri, notebookProviderInfo.id), options: notebookOptions };
			};
			const notebookUntitledEditorFactory: UntitledEditorInputFactoryFunction = async ({ resource, options }) => {
				const ref = await this._notebookEditorModelResolverService.resolve({ untitledResource: resource }, notebookProviderInfo.id);

				// untitled notebooks are disposed when they get saved. we should not hold a reference
				// to such a disposed notebook and therefore dispose the reference as well
				ref.object.notebook.onWillDispose(() => {
					ref!.dispose();
				});

				return { editor: NotebookEditorInput.create(this._instantiationService, ref.object.resource, notebookProviderInfo.id), options };
			};
			const notebookDiffEditorInputFactory: DiffEditorInputFactoryFunction = ({ modified, original }) => {
				return { editor: NotebookDiffEditorInput.create(this._instantiationService, modified.resource!, undefined, undefined, original.resource!, notebookProviderInfo.id) };
			};
			// Register the notebook editor
			disposables.add(this._editorResolverService.registerEditor(
				globPattern,
				notebookEditorInfo,
				notebookEditorOptions,
				notebookEditorInputFactory,
				notebookUntitledEditorFactory,
				notebookDiffEditorInputFactory
			));
			// Then register the schema handler as exclusive for that notebook
			disposables.add(this._editorResolverService.registerEditor(
				`${Schemas.vscodeNotebookCell}:/**/${globPattern}`,
				{ ...notebookEditorInfo, priority: RegisteredEditorPriority.exclusive },
				notebookEditorOptions,
				notebookEditorInputFactory,
				undefined,
				notebookDiffEditorInputFactory
			));
		}

		return disposables;
	}


	private _clear(): void {
		this._contributedEditors.clear();
		this._contributedEditorDisposables.clear();
	}

	get(viewType: string): NotebookProviderInfo | undefined {
		return this._contributedEditors.get(viewType);
	}

	add(info: NotebookProviderInfo): IDisposable {
		if (this._contributedEditors.has(info.id)) {
			throw new Error(`notebook type '${info.id}' ALREADY EXISTS`);
		}
		this._contributedEditors.set(info.id, info);
		const editorRegistration = this._registerContributionPoint(info);
		this._contributedEditorDisposables.add(editorRegistration);

		const mementoObject = this._memento.getMemento(StorageScope.GLOBAL, StorageTarget.MACHINE);
		mementoObject[NotebookProviderInfoStore.CUSTOM_EDITORS_ENTRY_ID] = Array.from(this._contributedEditors.values());
		this._memento.saveMemento();

		return toDisposable(() => {
			const mementoObject = this._memento.getMemento(StorageScope.GLOBAL, StorageTarget.MACHINE);
			mementoObject[NotebookProviderInfoStore.CUSTOM_EDITORS_ENTRY_ID] = Array.from(this._contributedEditors.values());
			this._memento.saveMemento();
			editorRegistration.dispose();
			this._contributedEditors.delete(info.id);
		});
	}

	getContributedNotebook(resource: URI): readonly NotebookProviderInfo[] {
		const result: NotebookProviderInfo[] = [];
		for (let info of this._contributedEditors.values()) {
			if (info.matches(resource)) {
				result.push(info);
			}
		}
		if (result.length === 0 && resource.scheme === Schemas.untitled) {
			// untitled resource and no path-specific match => all providers apply
			return Array.from(this._contributedEditors.values());
		}
		return result;
	}

	[Symbol.iterator](): Iterator<NotebookProviderInfo> {
		return this._contributedEditors.values();
	}
}

export class NotebookOutputRendererInfoStore {
	private readonly contributedRenderers = new Map</* rendererId */ string, NotebookOutputRendererInfo>();
	private readonly preferredMimetypeMemento: Memento;
	private readonly preferredMimetype = new Lazy<{ [notebookType: string]: { [mimeType: string]: /* rendererId */ string } }>(
		() => this.preferredMimetypeMemento.getMemento(StorageScope.WORKSPACE, StorageTarget.USER));

	constructor(
		@IStorageService storageService: IStorageService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
	) {
		this.preferredMimetypeMemento = new Memento('workbench.editor.notebook.preferredRenderer2', storageService);
	}

	clear() {
		this.contributedRenderers.clear();
	}

	get(rendererId: string): NotebookOutputRendererInfo | undefined {
		return this.contributedRenderers.get(rendererId);
	}

	getAll(): NotebookOutputRendererInfo[] {
		return Array.from(this.contributedRenderers.values());
	}

	add(info: NotebookOutputRendererInfo): void {
		if (this.contributedRenderers.has(info.id)) {
			return;
		}
		this.contributedRenderers.set(info.id, info);
	}

	/** Update and remember the preferred renderer for the given mimetype in this workspace */
	setPreferred(notebookProviderInfo: NotebookProviderInfo, mimeType: string, rendererId: string) {
		const mementoObj = this.preferredMimetype.getValue();
		const forNotebook = mementoObj[notebookProviderInfo.id];
		if (forNotebook) {
			forNotebook[mimeType] = rendererId;
		} else {
			mementoObj[notebookProviderInfo.id] = { [mimeType]: rendererId };
		}

		this.preferredMimetypeMemento.saveMemento();
	}

	findBestRenderers(notebookProviderInfo: NotebookProviderInfo | undefined, mimeType: string, kernelProvides: readonly string[] | undefined): IOrderedMimeType[] {

		const enum ReuseOrder {
			PreviouslySelected = 1 << 8,
			SameExtensionAsNotebook = 2 << 8,
			BuiltIn = 3 << 8,
			OtherRenderer = 4 << 8,
		}

		const preferred = notebookProviderInfo && this.preferredMimetype.getValue()[notebookProviderInfo.id]?.[mimeType];
		const notebookExtId = notebookProviderInfo?.extension?.value;
		const notebookId = notebookProviderInfo?.id;
		const renderers: { ordered: IOrderedMimeType, score: number }[] = Array.from(this.contributedRenderers.values())
			.map(renderer => {
				const ownScore = kernelProvides === undefined
					? renderer.matchesWithoutKernel(mimeType)
					: renderer.matches(mimeType, kernelProvides);

				if (ownScore === NotebookRendererMatch.Never) {
					return undefined;
				}

				const rendererExtId = renderer.extensionId.value;
				const reuseScore = preferred === renderer.id
					? ReuseOrder.PreviouslySelected
					: rendererExtId === notebookExtId || RENDERER_EQUIVALENT_EXTENSIONS.get(rendererExtId)?.has(notebookId!)
						? ReuseOrder.SameExtensionAsNotebook
						: renderer.isBuiltin ? ReuseOrder.BuiltIn : ReuseOrder.OtherRenderer;
				return {
					ordered: { mimeType, rendererId: renderer.id, isTrusted: true },
					score: reuseScore | ownScore,
				};
			}).filter(isDefined);

		if (mimeTypeSupportedByCore(mimeType)) {
			renderers.push({
				score: ReuseOrder.BuiltIn,
				ordered: {
					mimeType,
					rendererId: BUILTIN_RENDERER_ID,
					isTrusted: mimeTypeIsAlwaysSecure(mimeType) || this.workspaceTrustManagementService.isWorkspaceTrusted()
				}
			});
		}

		if (renderers.length === 0) {
			return [{ mimeType, rendererId: RENDERER_NOT_AVAILABLE, isTrusted: true }];
		}

		return renderers.sort((a, b) => a.score - b.score).map(r => r.ordered);
	}
}

class ModelData implements IDisposable {
	private readonly _modelEventListeners = new DisposableStore();

	constructor(
		readonly model: NotebookTextModel,
		onWillDispose: (model: INotebookTextModel) => void
	) {
		this._modelEventListeners.add(model.onWillDispose(() => onWillDispose(model)));
	}

	dispose(): void {
		this._modelEventListeners.dispose();
	}
}

export class NotebookService extends Disposable implements INotebookService {

	declare readonly _serviceBrand: undefined;

	private readonly _notebookProviders = new Map<string, ComplexNotebookProviderInfo | SimpleNotebookProviderInfo>();
	private _notebookProviderInfoStore: NotebookProviderInfoStore | undefined = undefined;
	private get notebookProviderInfoStore(): NotebookProviderInfoStore {
		if (!this._notebookProviderInfoStore) {
			this._notebookProviderInfoStore = this._register(this._instantiationService.createInstance(NotebookProviderInfoStore));
		}

		return this._notebookProviderInfoStore;
	}
	private readonly _notebookRenderersInfoStore = this._instantiationService.createInstance(NotebookOutputRendererInfoStore);
	private readonly _models = new ResourceMap<ModelData>();

	private readonly _onWillAddNotebookDocument = this._register(new Emitter<NotebookTextModel>());
	private readonly _onDidAddNotebookDocument = this._register(new Emitter<NotebookTextModel>());
	private readonly _onWillRemoveNotebookDocument = this._register(new Emitter<NotebookTextModel>());
	private readonly _onDidRemoveNotebookDocument = this._register(new Emitter<NotebookTextModel>());

	readonly onWillAddNotebookDocument = this._onWillAddNotebookDocument.event;
	readonly onDidAddNotebookDocument = this._onDidAddNotebookDocument.event;
	readonly onDidRemoveNotebookDocument = this._onDidRemoveNotebookDocument.event;
	readonly onWillRemoveNotebookDocument = this._onWillRemoveNotebookDocument.event;

	private readonly _onAddViewType = this._register(new Emitter<string>());
	readonly onAddViewType = this._onAddViewType.event;

	private readonly _onWillRemoveViewType = this._register(new Emitter<string>());
	readonly onWillRemoveViewType = this._onWillRemoveViewType.event;

	private readonly _onDidChangeEditorTypes = this._register(new Emitter<void>());
	onDidChangeEditorTypes: Event<void> = this._onDidChangeEditorTypes.event;

	private _cutItems: NotebookCellTextModel[] | undefined;
	private _lastClipboardIsCopy: boolean = true;

	private _displayOrder!: MimeTypeDisplayOrder;

	constructor(
		@IExtensionService private readonly _extensionService: IExtensionService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IAccessibilityService private readonly _accessibilityService: IAccessibilityService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		notebookRendererExtensionPoint.setHandler((renderers) => {
			this._notebookRenderersInfoStore.clear();

			for (const extension of renderers) {
				for (const notebookContribution of extension.value) {
					if (!notebookContribution.entrypoint) { // avoid crashing
						extension.collector.error(`Notebook renderer does not specify entry point`);
						continue;
					}

					const id = notebookContribution.id;
					if (!id) {
						extension.collector.error(`Notebook renderer does not specify id-property`);
						continue;
					}

					this._notebookRenderersInfoStore.add(new NotebookOutputRendererInfo({
						id,
						extension: extension.description,
						entrypoint: notebookContribution.entrypoint,
						displayName: notebookContribution.displayName,
						mimeTypes: notebookContribution.mimeTypes || [],
						dependencies: notebookContribution.dependencies,
						optionalDependencies: notebookContribution.optionalDependencies,
						requiresMessaging: notebookContribution.requiresMessaging,
					}));
				}
			}
		});

		const updateOrder = () => {
			this._displayOrder = new MimeTypeDisplayOrder(
				this._configurationService.getValue<string[]>(NotebookSetting.displayOrder) || [],
				this._accessibilityService.isScreenReaderOptimized()
					? ACCESSIBLE_NOTEBOOK_DISPLAY_ORDER
					: NOTEBOOK_DISPLAY_ORDER,
			);
		};

		updateOrder();

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectedKeys.indexOf(NotebookSetting.displayOrder) >= 0) {
				updateOrder();
			}
		}));

		this._register(this._accessibilityService.onDidChangeScreenReaderOptimized(() => {
			updateOrder();
		}));

		let decorationTriggeredAdjustment = false;
		let decorationCheckSet = new Set<string>();
		this._register(this._codeEditorService.onDecorationTypeRegistered(e => {
			if (decorationTriggeredAdjustment) {
				return;
			}

			if (decorationCheckSet.has(e)) {
				return;
			}

			const options = this._codeEditorService.resolveDecorationOptions(e, true);
			if (options.afterContentClassName || options.beforeContentClassName) {
				const cssRules = this._codeEditorService.resolveDecorationCSSRules(e);
				if (cssRules !== null) {
					for (let i = 0; i < cssRules.length; i++) {
						// The following ways to index into the list are equivalent
						if (
							((cssRules[i] as CSSStyleRule).selectorText.endsWith('::after') || (cssRules[i] as CSSStyleRule).selectorText.endsWith('::after'))
							&& (cssRules[i] as CSSStyleRule).cssText.indexOf('top:') > -1
						) {
							// there is a `::before` or `::after` text decoration whose position is above or below current line
							// we at least make sure that the editor top padding is at least one line
							const editorOptions = this.configurationService.getValue<IEditorOptions>('editor');
							updateEditorTopPadding(BareFontInfo.createFromRawSettings(editorOptions, getZoomLevel(), getPixelRatio()).lineHeight + 2);
							decorationTriggeredAdjustment = true;
							break;
						}
					}
				}
			}

			decorationCheckSet.add(e);
		}));
	}


	getEditorTypes(): IEditorType[] {
		return [...this.notebookProviderInfoStore].map(info => ({
			id: info.id,
			displayName: info.displayName,
			providerDisplayName: info.providerDisplayName
		}));
	}

	private _postDocumentOpenActivation(viewType: string) {
		// send out activations on notebook text model creation
		this._extensionService.activateByEvent(`onNotebook:${viewType}`);
		this._extensionService.activateByEvent(`onNotebook:*`);
	}

	async canResolve(viewType: string): Promise<boolean> {
		if (this._notebookProviders.has(viewType)) {
			return true;
		}

		await this._extensionService.whenInstalledExtensionsRegistered();

		const info = this._notebookProviderInfoStore?.get(viewType);
		const waitFor: Promise<any>[] = [Event.toPromise(Event.filter(this.onAddViewType, () => {
			return this._notebookProviders.has(viewType);
		}))];

		if (info && info.extension) {
			const extensionManifest = await this._extensionService.getExtension(info.extension.value);
			if (extensionManifest?.activationEvents && extensionManifest.activationEvents.indexOf(`onNotebook:${viewType}`) >= 0) {
				waitFor.push(this._extensionService._activateById(info.extension, { startup: false, activationEvent: `onNotebook:${viewType}}`, extensionId: info.extension }));
			}
		}

		await Promise.race(waitFor);

		return this._notebookProviders.has(viewType);
	}

	registerContributedNotebookType(viewType: string, data: INotebookContributionData): IDisposable {

		const info = new NotebookProviderInfo({
			extension: data.extension,
			id: viewType,
			displayName: data.displayName,
			providerDisplayName: data.providerDisplayName,
			exclusive: data.exclusive,
			priority: RegisteredEditorPriority.default,
			selectors: [],
		});

		info.update({ selectors: data.filenamePattern });

		const reg = this.notebookProviderInfoStore.add(info);
		this._onDidChangeEditorTypes.fire();

		return toDisposable(() => {
			reg.dispose();
			this._onDidChangeEditorTypes.fire();
		});
	}

	private _registerProviderData(viewType: string, data: SimpleNotebookProviderInfo | ComplexNotebookProviderInfo): IDisposable {
		if (this._notebookProviders.has(viewType)) {
			throw new Error(`notebook provider for viewtype '${viewType}' already exists`);
		}
		this._notebookProviders.set(viewType, data);
		this._onAddViewType.fire(viewType);
		return toDisposable(() => {
			this._onWillRemoveViewType.fire(viewType);
			this._notebookProviders.delete(viewType);
		});
	}

	registerNotebookController(viewType: string, extensionData: NotebookExtensionDescription, controller: INotebookContentProvider): IDisposable {
		this.notebookProviderInfoStore.get(viewType)?.update({ options: controller.options });
		return this._registerProviderData(viewType, new ComplexNotebookProviderInfo(viewType, controller, extensionData));
	}

	registerNotebookSerializer(viewType: string, extensionData: NotebookExtensionDescription, serializer: INotebookSerializer): IDisposable {
		this.notebookProviderInfoStore.get(viewType)?.update({ options: serializer.options });
		return this._registerProviderData(viewType, new SimpleNotebookProviderInfo(viewType, serializer, extensionData));
	}

	async withNotebookDataProvider(resource: URI, viewType?: string): Promise<ComplexNotebookProviderInfo | SimpleNotebookProviderInfo> {
		const providers = this.notebookProviderInfoStore.getContributedNotebook(resource);
		// If we have a viewtype specified we want that data provider, as the resource won't always map correctly
		const selected = viewType ? providers.find(p => p.id === viewType) : providers[0];
		if (!selected) {
			throw new Error(`NO contribution for resource: '${resource.toString()}'`);
		}
		await this.canResolve(selected.id);
		const result = this._notebookProviders.get(selected.id);
		if (!result) {
			throw new Error(`NO provider registered for view type: '${selected.id}'`);
		}
		return result;
	}

	getRendererInfo(rendererId: string): INotebookRendererInfo | undefined {
		return this._notebookRenderersInfoStore.get(rendererId);
	}

	updateMimePreferredRenderer(viewType: string, mimeType: string, rendererId: string, otherMimetypes: readonly string[]): void {
		const info = this.notebookProviderInfoStore.get(viewType);
		if (info) {
			this._notebookRenderersInfoStore.setPreferred(info, mimeType, rendererId);
		}

		this._displayOrder.prioritize(mimeType, otherMimetypes);
	}

	saveMimeDisplayOrder(target: ConfigurationTarget) {
		this._configurationService.updateValue(NotebookSetting.displayOrder, this._displayOrder.toArray(), target);
	}

	getRenderers(): INotebookRendererInfo[] {
		return this._notebookRenderersInfoStore.getAll();
	}

	// --- notebook documents: create, destory, retrieve, enumerate

	createNotebookTextModel(viewType: string, uri: URI, data: NotebookData, transientOptions: TransientOptions): NotebookTextModel {
		if (this._models.has(uri)) {
			throw new Error(`notebook for ${uri} already exists`);
		}
		const notebookModel = this._instantiationService.createInstance(NotebookTextModel, viewType, uri, data.cells, data.metadata, transientOptions);
		this._models.set(uri, new ModelData(notebookModel, this._onWillDisposeDocument.bind(this)));
		this._onWillAddNotebookDocument.fire(notebookModel);
		this._onDidAddNotebookDocument.fire(notebookModel);
		this._postDocumentOpenActivation(viewType);
		return notebookModel;
	}

	getNotebookTextModel(uri: URI): NotebookTextModel | undefined {
		return this._models.get(uri)?.model;
	}

	getNotebookTextModels(): Iterable<NotebookTextModel> {
		return Iterable.map(this._models.values(), data => data.model);
	}

	listNotebookDocuments(): NotebookTextModel[] {
		return [...this._models].map(e => e[1].model);
	}

	private _onWillDisposeDocument(model: INotebookTextModel): void {
		const modelData = this._models.get(model.uri);
		if (modelData) {
			this._onWillRemoveNotebookDocument.fire(modelData.model);
			this._models.delete(model.uri);
			modelData.dispose();
			this._onDidRemoveNotebookDocument.fire(modelData.model);
		}
	}

	getOutputMimeTypeInfo(textModel: NotebookTextModel, kernelProvides: readonly string[] | undefined, output: IOutputDto): readonly IOrderedMimeType[] {
		const sorted = this._displayOrder.sort(new Set<string>(output.outputs.map(op => op.mime)));
		const notebookProviderInfo = this.notebookProviderInfoStore.get(textModel.viewType);

		return sorted
			.flatMap(mimeType => this._notebookRenderersInfoStore.findBestRenderers(notebookProviderInfo, mimeType, kernelProvides))
			.sort((a, b) => (a.rendererId === RENDERER_NOT_AVAILABLE ? 1 : 0) - (b.rendererId === RENDERER_NOT_AVAILABLE ? 1 : 0));
	}

	getContributedNotebookTypes(resource?: URI): readonly NotebookProviderInfo[] {
		if (resource) {
			return this.notebookProviderInfoStore.getContributedNotebook(resource);
		}

		return [...this.notebookProviderInfoStore];
	}

	getContributedNotebookType(viewType: string): NotebookProviderInfo | undefined {
		return this.notebookProviderInfoStore.get(viewType);
	}

	getNotebookProviderResourceRoots(): URI[] {
		const ret: URI[] = [];
		this._notebookProviders.forEach(val => {
			if (val.extensionData.location) {
				ret.push(URI.revive(val.extensionData.location));
			}
		});

		return ret;
	}

	// --- copy & paste

	setToCopy(items: NotebookCellTextModel[], isCopy: boolean) {
		this._cutItems = items;
		this._lastClipboardIsCopy = isCopy;
	}

	getToCopy(): { items: NotebookCellTextModel[], isCopy: boolean; } | undefined {
		if (this._cutItems) {
			return { items: this._cutItems, isCopy: this._lastClipboardIsCopy };
		}

		return undefined;
	}

}

