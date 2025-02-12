/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ITextModel } from '../../../../../../editor/common/model.js';
import { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { TextModelPromptParser } from '../parsers/textModelPromptParser.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';

/**
 * Provides prompt syntax services.
 */
export const IPromptsService = createDecorator<IPromptsService>('IPromptsService');

/**
 * Provides prompt services.
 */
export interface IPromptsService extends IDisposable {
	readonly _serviceBrand: undefined;

	/**
	 * Get a prompt syntax parser for the provided text model.
	 * See {@link TextModelPromptParser} for more info on the parse API.
	 *
	 * @throws {Error} If a newly created parser gets immediately disposed.
	 */
	getSyntaxParserFor(
		model: ITextModel,
	): TextModelPromptParser & { disposed: false };
}
