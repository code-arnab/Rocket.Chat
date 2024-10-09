import type { ILivechatPriority } from '@rocket.chat/omnichannel-typings';
import type { FindCursor, ModifyResult } from 'mongodb';

import type { IBaseModel } from './IBaseModel';

export interface ILivechatPriorityModel extends IBaseModel<ILivechatPriority> {
	findOneByIdOrName(_idOrName: string, options?: any): Promise<ILivechatPriority | null>;
	findOneNameUsingRegex(_idOrName: string, options?: any): Promise<ILivechatPriority | null>;
	findByDirty(): FindCursor<Pick<ILivechatPriority, '_id'>>;
	canResetPriorities(): Promise<boolean>;
	resetPriorities(ids: ILivechatPriority['_id'][]): Promise<void>;
	updatePriority(_id: string, reset: boolean, name?: string): Promise<ModifyResult<ILivechatPriority>>;
}
