import type { APIResponse } from '@playwright/test';

import type { BaseTest } from './test';

export const setSettingValueById = async (api: BaseTest['api'], settingId: string, value: unknown): Promise<APIResponse> => {
	const response = await api.post(`/settings/${settingId}`, { value });

	if (response.status() !== 200) {
		throw new Error(
			`Failed to update setting ${settingId} with value "${value}" [http status: ${response.status()} ${response.statusText()}]`,
		);
	}

	return response;
};
