import type {
	AtLeast,
	ILivechatContact,
	ILivechatContactChannel,
	ILivechatCustomField,
	ILivechatVisitor,
	IOmnichannelRoom,
	IUser,
} from '@rocket.chat/core-typings';
import type { InsertionModel } from '@rocket.chat/model-typings';
import {
	LivechatVisitors,
	Users,
	LivechatRooms,
	LivechatCustomField,
	LivechatInquiry,
	Rooms,
	Subscriptions,
	LivechatContacts,
} from '@rocket.chat/models';
import { check } from 'meteor/check';
import { Meteor } from 'meteor/meteor';
import type { MatchKeysAndValues, OnlyFieldsOfType } from 'mongodb';

import { callbacks } from '../../../../lib/callbacks';
import { trim } from '../../../../lib/utils/stringUtils';
import {
	notifyOnRoomChangedById,
	notifyOnSubscriptionChangedByRoomId,
	notifyOnLivechatInquiryChangedByRoom,
} from '../../../lib/server/lib/notifyListener';
import { i18n } from '../../../utils/lib/i18n';

type RegisterContactProps = {
	_id?: string;
	token: string;
	name: string;
	username?: string;
	email?: string;
	phone?: string;
	customFields?: Record<string, unknown | string>;
	contactManager?: {
		username: string;
	};
};

type CreateContactParams = {
	name: string;
	emails?: string[];
	phones?: string[];
	unknown: boolean;
	customFields?: Record<string, string | unknown>;
	contactManager?: string;
	channels?: ILivechatContactChannel[];
};

type UpdateContactParams = {
	contactId: string;
	name?: string;
	emails?: string[];
	phones?: string[];
	customFields?: Record<string, unknown>;
	contactManager?: string;
	channels?: ILivechatContactChannel[];
};

export const Contacts = {
	async registerContact({
		token,
		name,
		email = '',
		phone,
		username,
		customFields = {},
		contactManager,
	}: RegisterContactProps): Promise<string> {
		check(token, String);

		const visitorEmail = email.trim().toLowerCase();

		if (contactManager?.username) {
			// verify if the user exists with this username and has a livechat-agent role
			const user = await Users.findOneByUsername(contactManager.username, { projection: { roles: 1 } });
			if (!user) {
				throw new Meteor.Error('error-contact-manager-not-found', `No user found with username ${contactManager.username}`);
			}
			if (!user.roles || !Array.isArray(user.roles) || !user.roles.includes('livechat-agent')) {
				throw new Meteor.Error('error-invalid-contact-manager', 'The contact manager must have the role "livechat-agent"');
			}
		}

		let contactId;

		const user = await LivechatVisitors.getVisitorByToken(token, { projection: { _id: 1 } });

		if (user) {
			contactId = user._id;
		} else {
			if (!username) {
				username = await LivechatVisitors.getNextVisitorUsername();
			}

			let existingUser = null;

			if (visitorEmail !== '' && (existingUser = await LivechatVisitors.findOneGuestByEmailAddress(visitorEmail))) {
				contactId = existingUser._id;
			} else {
				const userData = {
					username,
					ts: new Date(),
					token,
				};

				contactId = (await LivechatVisitors.insertOne(userData)).insertedId;
			}
		}

		const allowedCF = await getAllowedCustomFields();
		const livechatData: Record<string, string> = validateCustomFields(allowedCF, customFields, { ignoreAdditionalFields: true });

		const fieldsToRemove = {
			// if field is explicitely set to empty string, remove
			...(phone === '' && { phone: 1 }),
			...(visitorEmail === '' && { visitorEmails: 1 }),
			...(!contactManager?.username && { contactManager: 1 }),
		};

		const updateUser: { $set: MatchKeysAndValues<ILivechatVisitor>; $unset?: OnlyFieldsOfType<ILivechatVisitor> } = {
			$set: {
				token,
				name,
				livechatData,
				// if phone has some value, set
				...(phone && { phone: [{ phoneNumber: phone }] }),
				...(visitorEmail && { visitorEmails: [{ address: visitorEmail }] }),
				...(contactManager?.username && { contactManager: { username: contactManager.username } }),
			},
			...(Object.keys(fieldsToRemove).length && { $unset: fieldsToRemove }),
		};

		await LivechatVisitors.updateOne({ _id: contactId }, updateUser);

		const extraQuery = await callbacks.run('livechat.applyRoomRestrictions', {});
		const rooms: IOmnichannelRoom[] = await LivechatRooms.findByVisitorId(contactId, {}, extraQuery).toArray();

		if (rooms?.length) {
			for await (const room of rooms) {
				const { _id: rid } = room;

				const responses = await Promise.all([
					Rooms.setFnameById(rid, name),
					LivechatInquiry.setNameByRoomId(rid, name),
					Subscriptions.updateDisplayNameByRoomId(rid, name),
				]);

				if (responses[0]?.modifiedCount) {
					void notifyOnRoomChangedById(rid);
				}

				if (responses[1]?.modifiedCount) {
					void notifyOnLivechatInquiryChangedByRoom(rid, 'updated', { name });
				}

				if (responses[2]?.modifiedCount) {
					void notifyOnSubscriptionChangedByRoomId(rid);
				}
			}
		}

		return contactId;
	},
};

async function getContactManagerIdByUsername(username?: IUser['username']): Promise<IUser['_id'] | undefined> {
	if (!username) {
		return undefined;
	}

	const user = await Users.findOneByUsername(username, { projection: { _id: 1 } });

	return user?._id;
}

export async function migrateVisitorIdToContact(visitorId: ILivechatVisitor['_id']): Promise<ILivechatContact | null> {
	const visitor = await LivechatVisitors.findOneById(visitorId);
	const contactId = await migrateVisitorToContactId(visitor);

	if (!contactId) {
		return null;
	}

	return LivechatContacts.findOneById(contactId);
}

export async function migrateVisitorToContactId(visitor: ILivechatVisitor | null): Promise<ILivechatContact['_id'] | undefined> {
	if (!visitor) {
		return undefined;
	}

	// If a visitor was found, but it is already associated with a contact, skip the migration
	if (visitor.contactId) {
		return undefined;
	}

	const contactManager = await getContactManagerIdByUsername(visitor.contactManager?.username);
	// Use upsert so that if there's multiple requests processing at the same time, they don't interfere with each other
	await createContact(
		{
			name: visitor.name || visitor.username,
			emails: (visitor.visitorEmails || []).map((email) => email.address),
			phones: (visitor.phone || []).map((phone) => phone.phoneNumber),
			contactManager: contactManager || undefined,
			unknown: true,
			channels: [],
		},
		visitor._id,
	);

	await LivechatVisitors.updateById(visitor._id, { $set: { contactId: visitor._id } });
	return visitor._id;
}

export async function getContact(contactId: ILivechatContact['_id']): Promise<ILivechatContact | null> {
	const contact = await LivechatContacts.findOneById(contactId);
	if (contact) {
		return contact;
	}

	// If the contact was not found, search for a visitor with the same ID and no contactId, then migrate it into a contact
	return migrateVisitorIdToContact(contactId);
}

export function isSingleContactEnabled(): boolean {
	// The Single Contact feature is not yet available in production, but can already be partially used in test environments.
	return process.env.TEST_MODE?.toUpperCase() === 'TRUE';
}

export async function createContact(params: CreateContactParams, upsertId?: ILivechatContact['_id']): Promise<string> {
	const { name, emails, phones, customFields: receivedCustomFields = {}, contactManager, channels, unknown } = params;

	if (contactManager) {
		await validateContactManager(contactManager);
	}

	const allowedCustomFields = await getAllowedCustomFields();
	const customFields = validateCustomFields(allowedCustomFields, receivedCustomFields);

	const data: InsertionModel<ILivechatContact> = {
		name,
		emails,
		phones,
		contactManager,
		channels,
		customFields,
		unknown,
	};

	if (upsertId) {
		await LivechatContacts.upsertContact(upsertId, data);
		return upsertId;
	}

	const { insertedId } = await LivechatContacts.insertOne(data);

	return insertedId;
}

export async function updateContact(params: UpdateContactParams): Promise<ILivechatContact> {
	const { contactId, name, emails, phones, customFields: receivedCustomFields, contactManager, channels } = params;

	const contact = await LivechatContacts.findOneById<Pick<ILivechatContact, '_id'>>(contactId, { projection: { _id: 1 } });

	if (!contact) {
		throw new Error('error-contact-not-found');
	}

	if (contactManager) {
		await validateContactManager(contactManager);
	}

	const customFields = receivedCustomFields && validateCustomFields(await getAllowedCustomFields(), receivedCustomFields);

	const updatedContact = await LivechatContacts.updateContact(contactId, {
		name,
		emails,
		phones,
		contactManager,
		channels,
		customFields,
	});

	return updatedContact;
}

async function getAllowedCustomFields(): Promise<Pick<ILivechatCustomField, '_id' | 'label' | 'regexp' | 'required'>[]> {
	return LivechatCustomField.findByScope(
		'visitor',
		{
			projection: { _id: 1, label: 1, regexp: 1, required: 1 },
		},
		false,
	).toArray();
}

export function validateCustomFields(
	allowedCustomFields: AtLeast<ILivechatCustomField, '_id' | 'label' | 'regexp' | 'required'>[],
	customFields: Record<string, string | unknown>,
	options?: { ignoreAdditionalFields?: boolean },
): Record<string, string> {
	const validValues: Record<string, string> = {};

	for (const cf of allowedCustomFields) {
		if (!customFields.hasOwnProperty(cf._id)) {
			if (cf.required) {
				throw new Error(i18n.t('error-invalid-custom-field-value', { field: cf.label }));
			}
			continue;
		}
		const cfValue: string = trim(customFields[cf._id]);

		if (!cfValue || typeof cfValue !== 'string') {
			if (cf.required) {
				throw new Error(i18n.t('error-invalid-custom-field-value', { field: cf.label }));
			}
			continue;
		}

		if (cf.regexp) {
			const regex = new RegExp(cf.regexp);
			if (!regex.test(cfValue)) {
				throw new Error(i18n.t('error-invalid-custom-field-value', { field: cf.label }));
			}
		}

		validValues[cf._id] = cfValue;
	}

	if (!options?.ignoreAdditionalFields) {
		const allowedCustomFieldIds = new Set(allowedCustomFields.map((cf) => cf._id));
		for (const key in customFields) {
			if (!allowedCustomFieldIds.has(key)) {
				throw new Error(i18n.t('error-custom-field-not-allowed', { key }));
			}
		}
	}

	return validValues;
}

export async function validateContactManager(contactManagerUserId: string) {
	const contactManagerUser = await Users.findOneAgentById<Pick<IUser, '_id'>>(contactManagerUserId, { projection: { _id: 1 } });
	if (!contactManagerUser) {
		throw new Error('error-contact-manager-not-found');
	}
}
