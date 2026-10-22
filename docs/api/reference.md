# Federated chat server REST API

> **Generated** from [`openapi.yaml`](openapi.yaml) by `npm run docs:api --workspace server`; edit that file, not this one. The test suite checks this file is up to date, and that `openapi.yaml` matches the routes the server really has.

Version 0.16.0. The machine-readable form is [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1: import it into Swagger UI, Postman or a code generator).

This is the API of ONE homeserver, which its own clients (the web client, the desktop app) use for everything: accounts,
friends, direct messages, communities, channels, emoticons, uploads and notification settings. It is served under
`/api/v1` of the server's API address. Live events (new messages, presence, calls) come over a WebSocket at `/ws`, not
documented here (see `docs/spec.md`). Servers talk to each other over a separate, signed protocol
(`/federation/v1`, see `protocol/federation.md`), which is not part of this document.

**Identifiers.** Every id in a request or response is the object's `protocolId` (a ULID), never a database id. A person is
also named by an *identity*, `@username:domain`.

**Authentication.** Sign in with `POST /auth/login` (or `/auth/register`) to get an **access token** (valid 15 minutes) and a
**refresh token** (rotated on use). Send the access token as `Authorization: Bearer <token>`. When it expires, `POST
/auth/refresh` returns a new pair. Every operation below says whether it needs one. A request without one gets `401
{"error":"missing_token"}`, an expired or invalid one `401 {"error":"invalid_token"}`.

**Errors.** A failure is a JSON body `{"error": "<code>"}` (a bad request may add `details`), with the HTTP status that fits.
The codes are stable: clients should branch on them, not on the text. Codes that an operation can return are listed with it.

**Limits.** Requests are rate limited per client address (a stricter limit on sign-in and other password checks): the
answer is `429`. Request bodies are JSON unless the operation says otherwise.

**Remote people and communities.** A person or community may live on another server. Where an operation behaves differently
for them (it is proxied to their server, or refused) it says so.

This file is checked by the test suite against the routes the server really has, so an operation cannot be added or
removed without it. `docs/api/reference.md` is generated from it.

## Contents

- [Authentication](#authentication): Accounts, sign-in, sessions and two-factor authentication.
  - [`POST /auth/register`](#post-authregister): Create an account
  - [`POST /auth/login`](#post-authlogin): Sign in
  - [`POST /auth/2fa/login`](#post-auth2falogin): Finish a two-factor sign-in
  - [`POST /auth/2fa/setup`](#post-auth2fasetup): Start setting up two-factor sign-in
  - [`POST /auth/2fa/verify`](#post-auth2faverify): Turn two-factor sign-in on
  - [`POST /auth/2fa/disable`](#post-auth2fadisable): Turn two-factor sign-in off
  - [`POST /auth/refresh`](#post-authrefresh): Get a new access token
  - [`POST /auth/logout`](#post-authlogout): End a session
- [Users](#users): Your own profile and presence, and looking people up.
  - [`GET /users/me`](#get-usersme): Your account
  - [`PATCH /users/me`](#patch-usersme): Change your profile and privacy settings
  - [`PATCH /users/me/presence`](#patch-usersmepresence): Set your status
  - [`POST /users/me/export`](#post-usersmeexport): Download your data
  - [`POST /users/me/delete`](#post-usersmedelete): Ask for your account to be deleted
  - [`GET /users/search`](#get-userssearch): Find people on this server
  - [`GET /users/{username}`](#get-usersusername): One person on this server, by username
  - [`GET /users/{id}/profile`](#get-usersidprofile): A person's profile and how you relate to them
- [Friends](#friends): Friend requests, friends and blocking.
  - [`GET /friends`](#get-friends): Your friends
  - [`DELETE /friends/{userId}`](#delete-friendsuserid): Remove a friend
  - [`GET /friends/requests`](#get-friendsrequests): Waiting friend requests
  - [`POST /friends/requests`](#post-friendsrequests): Send a friend request
  - [`POST /friends/requests/{id}/accept`](#post-friendsrequestsidaccept): Accept a friend request
  - [`POST /friends/requests/{id}/decline`](#post-friendsrequestsiddecline): Decline a friend request
  - [`POST /friends/requests/{id}/cancel`](#post-friendsrequestsidcancel): Take back a friend request
  - [`GET /friends/blocks`](#get-friendsblocks): People you have blocked
  - [`POST /friends/blocks`](#post-friendsblocks): Block someone
  - [`DELETE /friends/blocks/{userId}`](#delete-friendsblocksuserid): Unblock someone
- [Conversations](#conversations): Direct and group chats, and calls in them.
  - [`GET /conversations`](#get-conversations): Your chats
  - [`POST /conversations`](#post-conversations): Start a chat
  - [`GET /conversations/{id}`](#get-conversationsid): One chat
  - [`POST /conversations/{id}/read`](#post-conversationsidread): Mark a chat as read
  - [`DELETE /conversations/{id}/members/me`](#delete-conversationsidmembersme): Leave a chat (or delete it for yourself)
  - [`GET /conversations/{id}/messages`](#get-conversationsidmessages): Messages in a chat
  - [`POST /conversations/{id}/messages`](#post-conversationsidmessages): Send a message in a chat
- [Communities](#communities): Communities, their members, roles, bans and invites.
  - [`GET /communities`](#get-communities): Your communities
  - [`POST /communities`](#post-communities): Create a community
  - [`GET /communities/{id}`](#get-communitiesid): One community
  - [`PATCH /communities/{id}`](#patch-communitiesid): Change a community
  - [`DELETE /communities/{id}`](#delete-communitiesid): Delete a community
  - [`PUT /communities/{id}/owner`](#put-communitiesidowner): Hand a community to another member
  - [`POST /communities/{id}/members`](#post-communitiesidmembers): Join a community
  - [`DELETE /communities/{id}/members/me`](#delete-communitiesidmembersme): Leave a community
  - [`DELETE /communities/{id}/members/{userId}`](#delete-communitiesidmembersuserid): Remove a member
  - [`POST /communities/{id}/members/{userId}/roles/{roleId}`](#post-communitiesidmembersuseridrolesroleid): Give a member a role
  - [`DELETE /communities/{id}/members/{userId}/roles/{roleId}`](#delete-communitiesidmembersuseridrolesroleid): Take a role from a member
  - [`GET /communities/{id}/audit-log`](#get-communitiesidaudit-log): What the community's managers did
  - [`GET /communities/{id}/bans`](#get-communitiesidbans): Banned people
  - [`POST /communities/{id}/bans`](#post-communitiesidbans): Ban someone
  - [`DELETE /communities/{id}/bans/{userId}`](#delete-communitiesidbansuserid): Lift a ban
  - [`GET /communities/{id}/invites`](#get-communitiesidinvites): Invites for a community
  - [`POST /communities/{id}/invites`](#post-communitiesidinvites): Make an invite
  - [`DELETE /communities/{id}/invites/{inviteId}`](#delete-communitiesidinvitesinviteid): Revoke an invite
  - [`POST /communities/{id}/roles`](#post-communitiesidroles): Make a role
  - [`PATCH /communities/{id}/roles/{roleId}`](#patch-communitiesidrolesroleid): Change a role
  - [`DELETE /communities/{id}/roles/{roleId}`](#delete-communitiesidrolesroleid): Delete a role
  - [`POST /communities/{id}/channels`](#post-communitiesidchannels): Make a channel
  - [`PUT /communities/{id}/channels/order`](#put-communitiesidchannelsorder): Reorder channels
  - [`PATCH /communities/{id}/channels/{channelId}`](#patch-communitiesidchannelschannelid): Rename a channel or change its topic
  - [`DELETE /communities/{id}/channels/{channelId}`](#delete-communitiesidchannelschannelid): Delete a channel
- [Channels](#channels): Channels and the messages in them.
  - [`GET /channels/{id}/messages`](#get-channelsidmessages): Messages in a channel
  - [`POST /channels/{id}/messages`](#post-channelsidmessages): Send a message in a channel
  - [`POST /channels/{id}/read`](#post-channelsidread): Mark a channel as read
- [Messages](#messages): Editing, deleting and reacting to a message, wherever it is.
  - [`PATCH /messages/{id}`](#patch-messagesid): Edit a message
  - [`DELETE /messages/{id}`](#delete-messagesid): Delete a message
  - [`DELETE /messages/{id}/embeds`](#delete-messagesidembeds): Take the link previews off your message
  - [`POST /messages/{id}/reactions`](#post-messagesidreactions): React to a message
  - [`DELETE /messages/{id}/reactions/{emoji}`](#delete-messagesidreactionsemoji): Take back an emoji reaction
  - [`DELETE /messages/{id}/emoticon-reactions/{emoticonId}`](#delete-messagesidemoticon-reactionsemoticonid): Take back a custom emoticon reaction
- [Emoticons](#emoticons): Custom emoticons.
  - [`GET /emoticons`](#get-emoticons): The emoticons you can use
  - [`POST /emoticons`](#post-emoticons): Make an emoticon
  - [`PATCH /emoticons/{id}`](#patch-emoticonsid): Change an emoticon
  - [`DELETE /emoticons/{id}`](#delete-emoticonsid): Delete an emoticon
  - [`POST /emoticons/{id}/save`](#post-emoticonsidsave): Save someone else's emoticon
  - [`DELETE /emoticons/{id}/save`](#delete-emoticonsidsave): Remove a saved emoticon
  - [`POST /emoticons/{id}/fork`](#post-emoticonsidfork): Make your own copy of an emoticon
  - [`POST /emoticons/{id}/sync`](#post-emoticonsidsync): Bring a fork up to date with its original
- [Media](#media): File uploads.
  - [`POST /media/upload`](#post-mediaupload): Upload a file
- [Notifications](#notifications): Sound and notification choices.
  - [`GET /notification-settings`](#get-notification-settings): Your notification choices
  - [`PUT /notification-settings`](#put-notification-settings): Change a notification choice
- [Sync](#sync): Catching up on what happened while a client was away.
  - [`GET /sync`](#get-sync): What happened while you were away
- [Directory](#directory): Browsing the public communities and people a server lists.
  - [`GET /directory/communities`](#get-directorycommunities): Browse the public communities of a server
  - [`GET /directory/people`](#get-directorypeople): Browse the people a server lists
- [Voice](#voice): Voice channels and calls (when the server has voice).
  - [`GET /conversations/voice`](#get-conversationsvoice): Calls going on in your chats
  - [`POST /conversations/{id}/voice-token`](#post-conversationsidvoice-token): Join the call in a chat
  - [`POST /channels/{id}/voice-token`](#post-channelsidvoice-token): Join a voice channel
  - [`GET /communities/{id}/voice`](#get-communitiesidvoice): Who is in a community's voice channels
  - [`POST /voice/webhook`](#post-voicewebhook): Voice server to this server: something happened in a room
- [Administration](#administration): The admin page's API. For admins only, and invisible to everyone else (see the note on each).
  - [`GET /admin/me`](#get-adminme): Whether you can use the admin page
  - [`GET /admin/audit-log`](#get-adminaudit-log): Everything that was done (the audit log)
  - [`POST /admin/sudo`](#post-adminsudo): Confirm it is you (sudo mode)
  - [`GET /admin/users`](#get-adminusers): The accounts on this server
  - [`GET /admin/users/{username}`](#get-adminusersusername): One account
  - [`POST /admin/users/{username}/suspend`](#post-adminusersusernamesuspend): Suspend an account
  - [`POST /admin/users/{username}/unsuspend`](#post-adminusersusernameunsuspend): Unsuspend an account
  - [`POST /admin/users/{username}/reset-password`](#post-adminusersusernamereset-password): Set a new password
  - [`POST /admin/users/{username}/disable-2fa`](#post-adminusersusernamedisable-2fa): Turn off two-factor sign-in
  - [`POST /admin/users/{username}/cancel-deletion`](#post-adminusersusernamecancel-deletion): Take a deletion back
  - [`POST /admin/users/{username}/delete`](#post-adminusersusernamedelete): Delete an account
  - [`PUT /admin/users/{username}/admin`](#put-adminusersusernameadmin): Make someone an admin, or take it away
  - [`GET /admin/registration-invites`](#get-adminregistration-invites): Registration invites
  - [`POST /admin/registration-invites`](#post-adminregistration-invites): Make registration invites
  - [`POST /admin/registration-invites/{id}/revoke`](#post-adminregistration-invitesidrevoke): Revoke a registration invite
- [Schemas](#schemas): the shapes of the objects the operations take and return

## Authentication

Accounts, sign-in, sessions and two-factor authentication.

### POST /auth/register

**Create an account**

Makes an account on this server and signs it in. Refused when registration is closed on this server. On an invite-only
server (the discovery document says `registration.inviteOnly`) an `inviteCode` is required; it is only used up once the
account exists.

**Needs sign-in:** no.

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `username` | string | Required. Lowercase letters, digits and underscores. (at least 3 characters, at most 32 characters) |
| `password` | string | Required. At least 8 characters with an uppercase letter, a lowercase letter, a number and a symbol. (at least 8 characters, at most 256 characters) |
| `displayName` | string | (at least 1 characters, at most 64 characters) |
| `inviteCode` | string | Needed on an invite-only server; ignored elsewhere. (at most 64 characters) |

**Responses**

- `201`: The account, signed in.

  Content type `application/json`.

  [SignedIn](#schema-signedin)

- `400`: `invalid_request` (with `details`), or `password_breached` (the password appears in a known breach).
- `403`: `registration_disabled`, or on an invite-only server `registration_invite_required`, `registration_invite_invalid`, `registration_invite_revoked`, `registration_invite_expired` or `registration_invite_used_up`.
- `409`: `username_taken`: someone has it, or someone did and deleted their account (a name is never given out again).

### POST /auth/login

**Sign in**

Checks the password. If the account has two-factor sign-in on, the answer is `{ "totpRequired": true, "challengeToken": ... }`
instead of tokens, and `POST /auth/2fa/login` finishes the sign-in. A suspended account is only told so once its password is
right, so nobody learns an account is suspended without knowing it. Signing in is also how a request to delete the account is
taken back: the answer then says `deletionCancelled: true`.

**Needs sign-in:** no.

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `username` | string | Required. |
| `password` | string | Required. |

**Responses**

- `200`: Signed in, or the second step is needed.

  Content type `application/json`.

  One of:

  1. [SignedIn](#schema-signedin)
  2. [TotpChallenge](#schema-totpchallenge)

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `invalid_credentials`: the same answer for an unknown username and a wrong password.
- `403`: `account_suspended`.

### POST /auth/2fa/login

**Finish a two-factor sign-in**

Exchanges the challenge from `POST /auth/login` and a code from the authenticator app, or one recovery code (each works once), for tokens.

**Needs sign-in:** no.

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `challengeToken` | string | Required. |
| `code` | string | The 6-digit code. One of `code` and `recoveryCode` is required. |
| `recoveryCode` | string |  |

**Responses**

- `200`: Signed in.

  Content type `application/json`.

  [SignedIn](#schema-signedin)

- `400`: `invalid_request`.
- `401`: `invalid_challenge_token` (wrong, expired, or not a challenge) or `invalid_code`.
- `403`: `account_suspended`.

### POST /auth/2fa/setup

**Start setting up two-factor sign-in**

Asks for the password again, then returns the secret to put in an authenticator app. It is not on until `POST /auth/2fa/verify` confirms a code.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `password` | string | Required. |

**Responses**

- `200`: The secret to add to an authenticator.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `secret` | string | The base32 secret. |
  | `otpauthUrl` | string | An `otpauth://` address for a QR code. |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `invalid_credentials` (wrong password) or no valid access token.
- `409`: `totp_already_enabled`.

### POST /auth/2fa/verify

**Turn two-factor sign-in on**

Confirms a code from the authenticator app. Returns the recovery codes, **once**: they are not kept in a form that can be shown again.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `code` | string | Required. |

**Responses**

- `200`: Two-factor sign-in is on.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `recoveryCodes` | array of string |  |

- `400`: `invalid_request` or `invalid_code`.

### POST /auth/2fa/disable

**Turn two-factor sign-in off**

Asks for the password again.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `password` | string | Required. |

**Responses**

- `204`: Off.
- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `invalid_credentials`.

### POST /auth/refresh

**Get a new access token**

Exchanges a refresh token for a new access token and a new refresh token. The one sent is used up, so keep the new one.

**Needs sign-in:** no.

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `refreshToken` | string | Required. |

**Responses**

- `200`: A new pair.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `accessToken` | string |  |
  | `refreshToken` | string |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `invalid_refresh_token`: unknown, used already, revoked or expired.
- `403`: `account_suspended`. The token is left as it is, so unsuspending brings the session back.

### POST /auth/logout

**End a session**

Revokes the refresh token. Always answers 204, whether or not the token was known.

**Needs sign-in:** no.

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `refreshToken` | string | Required. |

**Responses**

- `204`: Done.

## Users

Your own profile and presence, and looking people up.

### GET /users/me

**Your account**

Yourself, with the private fields only you are shown (two-factor, findability and contact settings, directory listing).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Responses**

- `200`: You.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `user` | [PublicUser](#schema-publicuser) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### PATCH /users/me

**Change your profile and privacy settings**

Any of the fields. `null` clears an optional one.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `displayName` | string | (at least 1 characters, at most 64 characters) |
| `bio` | string or null | (at most 512 characters) |
| `avatarUrl` | string or null | An uploaded file's `url` (see `POST /media/upload`) or an address. |
| `pronouns` | string or null | Plain text, up to 32 characters. |
| `accentColor` | string or null | `#rrggbb`. |
| `discoverable` | boolean | Whether servers you have nothing to do with may find you. |
| `contactPolicy` | `ANYONE` \| `SHARED_COMMUNITY` \| `LOCAL_ONLY` | Who may send you a friend request or start a conversation. |
| `listedInDirectory` | boolean | Whether the server's directory of people lists you. |

**Responses**

- `200`: Your account as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `user` | [PublicUser](#schema-publicuser) |  |

- `400`: `invalid_request`, `invalid_pronouns` or `invalid_accent_color`.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `409`: `discoverability_locked` or `directory_listing_locked`: the server has taken that choice away.

### PATCH /users/me/presence

**Set your status**

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `status` | `ONLINE` \| `AWAY` \| `BUSY` \| `DO_NOT_DISTURB` \| `INVISIBLE` \| `OFFLINE` |  |
| `customStatus` | string or null | (at most 128 characters) |

**Responses**

- `200`: Your account as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `user` | [PublicUser](#schema-publicuser) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.

### POST /users/me/export

**Download your data**

Everything this server holds about you, as one JSON file: your account, friends, communities, chats, the messages you
wrote and have not deleted, reactions, emoticons and notification choices. Never other people's messages, a password hash,
2FA secret, recovery codes or a token. Asks for the password again and is behind the sign-in rate limit. The answer is
streamed and sent as an attachment (`Content-Disposition`), not cached.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `password` | string | Required. |

**Responses**

- `200`: The file.

  Content type `application/json`.

  `format` is `federated-chat-export` with a `version`. Sections: `server`, `account`, `friends`, `friendRequests`, `blocked`, `communities`, `conversations`, `messages`, `reactions`, `emoticons`, `notificationSettings`.

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `invalid_credentials`, or no valid access token.

### POST /users/me/delete

**Ask for your account to be deleted**

Starts the deletion of your account. It does not erase anything yet: your sessions end (you are signed out everywhere) and a
grace period starts (`graceDays`, 14 unless the operator set `ACCOUNT_DELETION_GRACE_DAYS`), during which **signing in again
cancels it** (the sign-in answer then has `deletionCancelled: true`). When it is over the account is erased: your messages
(channels, direct messages and groups), friendships, requests, blocks, memberships, saved emoticons, choices, files only you
used and sessions are removed; other servers are told to forget you; and what is left is an anonymous "Deleted user" row.
Your username is kept and can never be registered again. Asking again keeps the first date.

It wants everything that proves it is you and that you mean it: the password, your username typed out, and a code (or one
recovery code) when you have two-factor sign-in on. It is refused with `owns_communities` while you own a community, with
the list; transfer each one or delete it first. Behind the sign-in rate limit.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `password` | string | Required. |
| `username` | string | Required. Your own username, as a check that you mean it. Capitals and spaces around it do not matter. |
| `code` | string | From the authenticator app. Needed when two-factor sign-in is on, unless `recoveryCode` is given. |
| `recoveryCode` | string |  |

**Responses**

- `202`: Asked for. Nothing is erased yet.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `scheduledFor` | string | Required. When the account is erased unless you sign in first. |
  | `graceDays` | integer | Required. |

- `400`: `invalid_request`, or `username_mismatch`: the username typed is not yours.
- `401`: `invalid_credentials` (no valid access token, or a wrong password), or `invalid_code` (two-factor sign-in is on and the code is missing or wrong).
- `409`: `owns_communities`: you own communities, which would be left without an owner. `communities` lists them as `{ id, name }`.

### GET /users/search

**Find people on this server**

Matches the start of a username or display name. Fewer than 2 characters finds nobody. People you are friends with, have blocked or are blocked by are left out.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `q` | query | string | Required. (at least 2 characters) |

**Responses**

- `200`: Up to a page of matches.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `users` | array of [PublicUser](#schema-publicuser) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.

### GET /users/{username}

**One person on this server, by username**

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `username` | path | string | Required. |

**Responses**

- `200`: The person (an INVISIBLE status shows as offline).

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `user` | [PublicUser](#schema-publicuser) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### GET /users/{id}/profile

**A person's profile and how you relate to them**

Works for people on other servers too: this server asks theirs (a few seconds at most) and falls back to what it has cached
(`homeServerReachable: false`). Someone who has blocked you is `404`.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. The person's id (not their username). |

**Responses**

- `200`: The profile.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `profile` | [UserProfile](#schema-userprofile) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

## Friends

Friend requests, friends and blocking.

### GET /friends

**Your friends**

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Responses**

- `200`: Your friends, including people on other servers.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `friends` | array of [PublicUser](#schema-publicuser) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.

### DELETE /friends/{userId}

**Remove a friend**

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `userId` | path | string | Required. The friend's id. |

**Responses**

- `204`: They are no longer a friend (also when they were not).
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### GET /friends/requests

**Waiting friend requests**

Only requests that are still waiting for an answer.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `direction` | query | `incoming` \| `outgoing` | `incoming` or `outgoing`; both when left out. |

**Responses**

- `200`: The requests, newest first.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `requests` | array of [FriendRequest](#schema-friendrequest) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.

### POST /friends/requests

**Send a friend request**

To a person on this server by username, or on another by identity (`@name:domain`), which this server then delivers.
What the other person has chosen about who may contact them is applied here and again on their own server.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `username` | string | Required. A username, or `@username:domain` for someone on another server. |
| `message` | string | (at most 256 characters) |

**Responses**

- `201`: Sent.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `request` | [FriendRequest](#schema-friendrequest) |  |

- `400`: `invalid_request` or `cannot_friend_self`.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `blocked` (either way) or `contact_not_allowed`.
- `404`: `user_not_found`.
- `409`: `already_friends` or `request_already_pending`.

### POST /friends/requests/{id}/accept

**Accept a friend request**

Only the person it was sent to.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `200`: Accepted.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `friend` | [PublicUser](#schema-publicuser) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `already_resolved`.

### POST /friends/requests/{id}/decline

**Decline a friend request**

Only the person it was sent to.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `204`: Declined.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `already_resolved`.

### POST /friends/requests/{id}/cancel

**Take back a friend request**

Only the person who sent it.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `204`: Cancelled.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `already_resolved`.

### GET /friends/blocks

**People you have blocked**

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Responses**

- `200`: The people you blocked.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `blocked` | array of [PublicUser](#schema-publicuser) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.

### POST /friends/blocks

**Block someone**

Only people on this server can be blocked. It also removes any friendship and waiting request between you.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `username` | string | Required. |

**Responses**

- `204`: Blocked.
- `400`: `invalid_request` or `cannot_block_self`.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `user_not_found`.

### DELETE /friends/blocks/{userId}

**Unblock someone**

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `userId` | path | string | Required. |

**Responses**

- `204`: Unblocked.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

## Conversations

Direct and group chats, and calls in them.

### GET /conversations

**Your chats**

Direct and group chats you are in, most recently active first, each with its last message and whether you have unread ones.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Responses**

- `200`: The chats.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `conversations` | array of [Conversation](#schema-conversation) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.

### POST /conversations

**Start a chat**

A direct chat (`DM`, exactly one other person) or a group (`GROUP`). Members are named by username, or identity for people on
other servers. Asking for a direct chat that already exists returns it (`200`). What each person has chosen about who may
start a chat with them is applied; a group is all-or-nothing.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `type` | `DM` \| `GROUP` | Required. |
| `memberUsernames` | array of string | Required. The other members; you are added. At most one fewer than the group size limit. |
| `title` | string | For a group. (at most 100 characters) |

**Responses**

- `200`: A direct chat that already existed.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `conversation` | [Conversation](#schema-conversation) |  |

- `201`: Started.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `conversation` | [Conversation](#schema-conversation) |  |

- `400`: `invalid_request` or `dm_requires_exactly_two_members`.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `blocked` or `contact_not_allowed`.
- `404`: `one_or_more_users_not_found`.

### GET /conversations/{id}

**One chat**

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `200`: The chat with its members.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `conversation` | [Conversation](#schema-conversation) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### POST /conversations/{id}/read

**Mark a chat as read**

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `204`: Marked.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### DELETE /conversations/{id}/members/me

**Leave a chat (or delete it for yourself)**

Removes the chat from your view only; the others keep it. A chat nobody is in any more is deleted with its messages. Takes you out of a call in it.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `204`: Left.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### GET /conversations/{id}/messages

**Messages in a chat**

Oldest first within the page. For the next older page pass the id of the oldest message you have as `before`.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `limit` | query | integer | (at most 200, default `50`) |
| `before` | query | string | A message id; only messages older than it. |

**Responses**

- `200`: A page of messages.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `messages` | array of [Message](#schema-message) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### POST /conversations/{id}/messages

**Send a message in a chat**

Text, with optional attachments (files already uploaded with `POST /media/upload`) and a reply. Or an **invitation** to a
community you are in (`invite`, with no text and no attachments): the card's name and server are filled in from this
server's own records, never taken from the request. Delivered to members on other servers as well.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `content` | string | Required unless this is an invitation. (at least 1 characters, at most 8000 characters) |
| `replyToId` | string |  |
| `attachments` | array of [AttachmentInput](#schema-attachmentinput) | (at most 10 items) |
| `invite` | object |  |

**Responses**

- `201`: Sent.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `message` | [Message](#schema-message) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `not_a_member` (of the community), `forbidden` (you may not invite), `community_local_only`, or a reason the community's own server gave.
- `404`: `not_found` (the chat) or `community_not_found`.
- `422`: `invite_not_possible`.
- `502`: `federation_unreachable`: another server could not be reached.

## Communities

Communities, their members, roles, bans and invites.

### GET /communities

**Your communities**

Every community you are in, on this server or another, each with its channels, roles and members.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Responses**

- `200`: The communities.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `communities` | array of [Community](#schema-community) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.

### POST /communities

**Create a community**

You become its owner, with a `#general` channel and the default roles.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `name` | string | Required. (at least 1 characters, at most 100 characters) |
| `description` | string | (at most 500 characters) |

**Responses**

- `201`: Created.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `community` | [Community](#schema-community) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.

### GET /communities/{id}

**One community**

Only for members.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `200`: The community.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `community` | [Community](#schema-community) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `not_a_member`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### PATCH /communities/{id}

**Change a community**

Needs the Manage community permission. A community on another server cannot be changed from here.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `name` | string | (at least 1 characters, at most 100 characters) |
| `description` | string or null | (at most 500 characters) |
| `iconUrl` | string or null | An uploaded file's `url` or an http(s) image address. |
| `iconText` | string or null | 1 to 3 characters shown on the tile when there is no picture. |
| `iconColor` | string or null | `#rrggbb`. |
| `visibility` | `UNLISTED` \| `INVITE_ONLY` \| `LOCAL_ONLY` \| `PUBLIC` | Who can join. PUBLIC also lists it in the server's directory. |
| `openJoin` | boolean | The old yes/no, still accepted: `false` means invite-only. |

**Responses**

- `200`: The community as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `community` | [Community](#schema-community) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `remote_community_management_not_supported`, or `visibility_limited` (the server does not let a community be that exposed; `limit` says how much it does).

### DELETE /communities/{id}

**Delete a community**

Owner only. Takes its channels, messages, roles, memberships and emoticons with it; members are told and other servers drop their copy.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `204`: Deleted.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `remote_community_management_not_supported`.

### PUT /communities/{id}/owner

**Hand a community to another member**

Owner only; asks for the password again and is behind the sign-in rate limit. The new owner must be a member with an account on this server.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `userId` | string | Required. The new owner's id. |
| `password` | string | Required. |

**Responses**

- `200`: The community with its new owner.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `community` | [Community](#schema-community) |  |

- `400`: `invalid_request`, `new_owner_must_be_local` or `already_owner`.
- `401`: `invalid_credentials`, or no valid access token.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`, `user_not_found` or `not_a_member`.
- `409`: `remote_community_management_not_supported` or `ownership_changed` (it changed hands while you asked).

### POST /communities/{id}/members

**Join a community**

`id` is the community's id on this server, or a full reference for one on another server, **URL-encoded**:
`<id>:<server>` or `<id>:<server>#<code>` (a `#` is not sent unless encoded). An invite code may instead be in the body.
Whether you may join is decided by the community's own server: banned people are refused, an invite-only community needs a
good code, and a local-only one takes nobody from another server (and answers as if it did not exist).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body** (optional)

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `inviteCode` | string | 10 characters of the invite alphabet, in any case. |

**Responses**

- `201`: You are in (also when you already were).

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `community` | [Community](#schema-community) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `banned`, `invite_required`, `invite_invalid`, `invite_revoked`, `invite_expired` or `invite_used_up`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `502`: `federation_unreachable`.

### DELETE /communities/{id}/members/me

**Leave a community**

The owner cannot leave without handing it over. Takes you out of its voice channels.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `204`: Left.
- `400`: `owner_cannot_leave`.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `502`: `federation_unreachable`.

### DELETE /communities/{id}/members/{userId}

**Remove a member**

Needs the Kick members permission. They can join again. The owner cannot be removed.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `userId` | path | string | Required. |

**Responses**

- `204`: Removed.
- `400`: `cannot_kick_owner`.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found` or `user_not_found`.
- `409`: `remote_community_management_not_supported`.

### POST /communities/{id}/members/{userId}/roles/{roleId}

**Give a member a role**

Needs the Manage roles permission, and you can only give a role made of permissions you hold yourself.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `userId` | path | string | Required. |
| `roleId` | path | string | Required. |

**Responses**

- `204`: Done (also when they already had it).
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden` or `role_exceeds_your_permissions`.
- `404`: `not_found`, `role_not_found`, `user_not_found` or `not_a_member`.

### DELETE /communities/{id}/members/{userId}/roles/{roleId}

**Take a role from a member**

Needs the Manage roles permission, under the same limit as giving one.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `userId` | path | string | Required. |
| `roleId` | path | string | Required. |

**Responses**

- `204`: Done.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden` or `role_exceeds_your_permissions`.
- `404`: `not_found`, `role_not_found`, `user_not_found` or `not_a_member`.

### GET /communities/{id}/audit-log

**What the community's managers did**

The audit log for this community, newest first: kicks, bans, roles, channels, settings, ownership and a moderator removing someone's
message. Ids and labels only, never what anyone wrote. Needs the permission to manage the community. Not for a community that lives
on another server (409), which keeps its own.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `before` | query | integer | (at least 1) |
| `limit` | query | integer | (at least 1, at most 200, default `50`) |
| `action` | query | string |  |

**Responses**

- `200`: A page of entries.

  Content type `application/json`.

  [AuditPage](#schema-auditpage)

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `remote_community_management_not_supported`.

### GET /communities/{id}/bans

**Banned people**

Needs the Ban members permission.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `200`: The bans.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `bans` | array of [CommunityBan](#schema-communityban) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `remote_community_management_not_supported`.

### POST /communities/{id}/bans

**Ban someone**

Needs the Ban members permission. Removes them if they are a member and stops them joining again. The owner cannot be banned.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `protocolId` | string | Required. The person's id. |
| `reason` | string | (at most 256 characters) |

**Responses**

- `204`: Banned.
- `400`: `invalid_request` or `cannot_ban_owner`.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found` or `user_not_found`.
- `409`: `remote_community_management_not_supported`.

### DELETE /communities/{id}/bans/{userId}

**Lift a ban**

Needs the Ban members permission.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `userId` | path | string | Required. |

**Responses**

- `204`: Lifted.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found` or `user_not_found`.
- `409`: `remote_community_management_not_supported`.

### GET /communities/{id}/invites

**Invites for a community**

Your own invites, or everyone's with the Manage community permission (`seesAll` says which). Invites made for cards sent to
friends are left out unless `cards=1`. Only on the community's own server.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `cards` | query | `1` |  |

**Responses**

- `200`: The invites.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `invites` | array of [Invite](#schema-invite) |  |
  | `seesAll` | boolean |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `not_community_home`: the community is on another server, which is where its invites are.

### POST /communities/{id}/invites

**Make an invite**

Needs the Create invite permission. For a community on another server the request goes to that server, and the answer has no
`id` (only that server can list or revoke it).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body** (optional)

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `expiresInSeconds` | integer or null | One of 3600, 86400, 604800, or `null` for never. |
| `maxUses` | integer or null | How many people may use it; `null` for any number. (at least 1) |

**Responses**

- `201`: Made.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `invite` | [Invite](#schema-invite) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden` or `not_a_member`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `502`: `federation_unreachable`.

### DELETE /communities/{id}/invites/{inviteId}

**Revoke an invite**

Your own, or anyone's with the Manage community permission. People already in stay in.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `inviteId` | path | string | Required. |

**Responses**

- `204`: Revoked.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found` or `invite_not_found`.
- `409`: `not_community_home`.

### POST /communities/{id}/roles

**Make a role**

Needs the Manage roles permission, and the role can only hold permissions you hold yourself.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `name` | string | Required. (at least 1 characters, at most 50 characters) |
| `color` | string | `#rrggbb`. |
| `permissions` | [PermissionBits](#schema-permissionbits) |  |

**Responses**

- `201`: Made.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `role` | [Role](#schema-role) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden` or `role_exceeds_your_permissions`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `remote_community_management_not_supported`.

### PATCH /communities/{id}/roles/{roleId}

**Change a role**

Needs the Manage roles permission, under the same limit. The default role cannot be renamed.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `roleId` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `name` | string | (at least 1 characters, at most 50 characters) |
| `color` | string or null | `#rrggbb`, or `null` for none. |
| `permissions` | [PermissionBits](#schema-permissionbits) |  |

**Responses**

- `200`: The role as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `role` | [Role](#schema-role) |  |

- `400`: `invalid_request` or `cannot_rename_default_role`.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden` or `role_exceeds_your_permissions`.
- `404`: `not_found` or `role_not_found`.

### DELETE /communities/{id}/roles/{roleId}

**Delete a role**

Needs the Manage roles permission, under the same limit. The default role cannot be deleted.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `roleId` | path | string | Required. |

**Responses**

- `204`: Deleted.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden` or `role_exceeds_your_permissions`.
- `404`: `not_found` or `role_not_found`.
- `409`: `cannot_delete_default_role`.

### POST /communities/{id}/channels

**Make a channel**

Needs the Manage channels permission. A voice channel needs voice on this server.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `name` | string | Required. (at least 1 characters, at most 50 characters) |
| `topic` | string | (at most 256 characters) |
| `type` | `TEXT` \| `VOICE` | (default `TEXT`) |

**Responses**

- `201`: Made.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `channel` | [Channel](#schema-channel) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `remote_community_management_not_supported` or `voice_not_enabled`.

### PUT /communities/{id}/channels/order

**Reorder channels**

Needs the Manage channels permission. Lists every channel of the community, once each, in the new order.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `order` | array of string | Required. The channel ids. |

**Responses**

- `200`: The channels in their new order.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `channels` | array of [Channel](#schema-channel) |  |

- `400`: `invalid_request` or `invalid_order` (not every channel exactly once).
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### PATCH /communities/{id}/channels/{channelId}

**Rename a channel or change its topic**

Needs the Manage channels permission. A blank topic clears it.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `channelId` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `name` | string | (at least 1 characters, at most 50 characters) |
| `topic` | string or null | (at most 256 characters) |

**Responses**

- `200`: The channel as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `channel` | [Channel](#schema-channel) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found` or `channel_not_found`.

### DELETE /communities/{id}/channels/{channelId}

**Delete a channel**

Needs the Manage channels permission. Its messages go with it. A community always keeps one channel.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `channelId` | path | string | Required. |

**Responses**

- `204`: Deleted.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found` or `channel_not_found`.
- `409`: `last_channel`.

## Channels

Channels and the messages in them.

### GET /channels/{id}/messages

**Messages in a channel**

Oldest first within the page. For the next older page pass the id of the oldest message you have as `before`. A voice channel has no messages.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `limit` | query | integer | (at most 200, default `50`) |
| `before` | query | string | A message id; only messages older than it. |

**Responses**

- `200`: A page of messages.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `messages` | array of [Message](#schema-message) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `not_a_text_channel`.

### POST /channels/{id}/messages

**Send a message in a channel**

Needs the Send messages permission in the community. For a channel in a community on another server the request is passed
to that server, which decides.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `content` | string | Required. (at least 1 characters, at most 8000 characters) |
| `replyToId` | string |  |
| `attachments` | array of [AttachmentInput](#schema-attachmentinput) | (at most 10 items) |

**Responses**

- `201`: Sent.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `message` | [Message](#schema-message) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `not_a_text_channel`.
- `502`: `federation_unreachable`.

### POST /channels/{id}/read

**Mark a channel as read**

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `204`: Marked.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `not_a_text_channel`.

## Messages

Editing, deleting and reacting to a message, wherever it is.

### PATCH /messages/{id}

**Edit a message**

Only your own, and not an invitation card. For a message in a community on another server the request is passed to that server.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `content` | string | Required. (at least 1 characters, at most 8000 characters) |

**Responses**

- `200`: The message as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `message` | [Message](#schema-message) |  |

- `400`: `invalid_request` or `cannot_edit_invite`.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `502`: `federation_unreachable`.

### DELETE /messages/{id}

**Delete a message**

Your own message, or in a community one you may delete (the Delete messages permission). In a direct chat only the sender may.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `204`: Deleted.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `502`: `federation_unreachable`.

### DELETE /messages/{id}/embeds

**Take the link previews off your message**

Only the author, and only for a message this server holds as the original (not a copy of one from another server). The previews
go for everyone who sees the message, here and on other servers, and editing the message does not bring them back.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `204`: Taken off.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `not_hosted_here`: the message is in a community on another server, which is where its previews are decided.

### POST /messages/{id}/reactions

**React to a message**

With one Unicode emoji, or with a custom emoticon you can use (a reference to it, never its `:trigger:`). Reacting twice
with the same thing does nothing. A message can have at most 20 different reactions.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body**

Content type `application/json`.

One of:

1.

   | Field | Type | Description |
   |---|---|---|
   | `emoji` | string | Required. Exactly one emoji. |

2.

   | Field | Type | Description |
   |---|---|---|
   | `emoticonId` | string | Required. |

**Responses**

- `200`: The message with its reactions.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `message` | [Message](#schema-message) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden` (you may not react here) or `emoticon_not_available`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `too_many_reactions`.
- `502`: `federation_unreachable`.

### DELETE /messages/{id}/reactions/{emoji}

**Take back an emoji reaction**

Your own. Takes the emoji in either of its spellings.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `emoji` | path | string | Required. The emoji, URL-encoded. |

**Responses**

- `200`: The message with its reactions.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `message` | [Message](#schema-message) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `502`: `federation_unreachable`.

### DELETE /messages/{id}/emoticon-reactions/{emoticonId}

**Take back a custom emoticon reaction**

Your own, whether or not you can still use that emoticon.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |
| `emoticonId` | path | string | Required. |

**Responses**

- `200`: The message with its reactions.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `message` | [Message](#schema-message) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `502`: `federation_unreachable`.

## Emoticons

Custom emoticons.

### GET /emoticons

**The emoticons you can use**

Your own, the ones you saved, and those of every community you are in.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Responses**

- `200`: The three sets.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `personal` | array of [Emoticon](#schema-emoticon) | Made by you, for yourself. |
  | `saved` | array of [Emoticon](#schema-emoticon) | Other people's you saved; `trigger` is your own choice if you set one. |
  | `community` | array of [Emoticon](#schema-emoticon) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.

### POST /emoticons

**Make an emoticon**

For yourself, or for a community you are in (give its `communityId`). The picture is an uploaded file's `url`.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `name` | string | Required. (at least 1 characters, at most 40 characters) |
| `trigger` | string | Required. Looks like `:name:`. |
| `imageUrl` | string | Required. |
| `communityId` | string |  |
| `allowSave` | boolean |  |
| `allowExport` | boolean |  |
| `allowFork` | boolean |  |

**Responses**

- `201`: Made.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `emoticon` | [Emoticon](#schema-emoticon) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `not_a_member`.
- `404`: `community_not_found`.
- `409`: `trigger_already_in_use`.

### PATCH /emoticons/{id}

**Change an emoticon**

Its creator, or for a community's emoticon someone with the Manage emoticons permission.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `name` | string | (at least 1 characters, at most 40 characters) |
| `imageUrl` | string |  |
| `allowSave` | boolean |  |
| `allowFork` | boolean |  |

**Responses**

- `200`: The emoticon as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `emoticon` | [Emoticon](#schema-emoticon) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### DELETE /emoticons/{id}

**Delete an emoticon**

Its creator, or for a community's emoticon someone with the Manage emoticons permission. Reactions made with it go too.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `204`: Deleted.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### POST /emoticons/{id}/save

**Save someone else's emoticon**

Only if its creator allows saving. You may choose your own trigger for it.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body** (optional)

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `trigger` | string |  |

**Responses**

- `204`: Saved.
- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `saving_not_allowed`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `trigger_already_in_use`.

### DELETE /emoticons/{id}/save

**Remove a saved emoticon**

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `204`: Removed.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### POST /emoticons/{id}/fork

**Make your own copy of an emoticon**

Only if its creator allows forking. The copy is yours, remembers where it came from, and can be brought up to date with `sync`.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `name` | string | Required. (at least 1 characters, at most 40 characters) |
| `trigger` | string | Required. |
| `imageUrl` | string | A different picture; the original's when left out. |

**Responses**

- `201`: Made.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `emoticon` | [Emoticon](#schema-emoticon) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forking_not_allowed`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `trigger_already_in_use`.

### POST /emoticons/{id}/sync

**Bring a fork up to date with its original**

Yours only, and only a fork.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `200`: The fork as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `emoticon` | [Emoticon](#schema-emoticon) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found` or `not_a_fork`.

## Media

File uploads.

### POST /media/upload

**Upload a file**

A picture, or another file a message can carry. The answer is what to put in `avatarUrl`, `imageUrl` or a message's
`attachments`. Only some content types are accepted, up to the server's size limit.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `multipart/form-data`.

| Field | Type | Description |
|---|---|---|
| `file` | file | Required. |

**Responses**

- `201`: Stored.

  Content type `application/json`.

  [AttachmentInput](#schema-attachmentinput)

- `400`: `missing_file`, or `upload_failed` (too big, or a type the server does not take; `message` says which).
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.

## Notifications

Sound and notification choices.

### GET /notification-settings

**Your notification choices**

What you want to hear and see when a message arrives, for everything and for single communities, channels and chats. Whether to alert for a message is decided by the client when it arrives.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Responses**

- `200`: The choices you have made (places with no choice are not listed).

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `settings` | array of [NotificationSetting](#schema-notificationsetting) |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.

### PUT /notification-settings

**Change a notification choice**

For one place. Naming `sound`, `notify` or both changes them; leaving one out leaves it as it was; `null` takes the choice
away (the next level up applies). A place with neither choice is forgotten. Your other devices are told.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `type` | `GLOBAL` \| `COMMUNITY` \| `CHANNEL` \| `CONVERSATION` | Required. |
| `id` | string | The community's, channel's or chat's id. Not allowed for `GLOBAL`, required for the others. |
| `sound` | boolean or null |  |
| `notify` | boolean or null |  |

**Responses**

- `200`: The choice for that place, and all of them.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `setting` | [NotificationSetting](#schema-notificationsetting) or null |  |
  | `settings` | array of [NotificationSetting](#schema-notificationsetting) |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `409`: `too_many_settings`.

## Sync

Catching up on what happened while a client was away.

### GET /sync

**What happened while you were away**

The events recorded for you after `cursor` (the same kinds the WebSocket sends live), oldest first, with the cursor for the
next call. Leave `cursor` out to get the most recent window and a cursor to continue from. `hasMore` says to ask again.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `cursor` | query | string | The `nextCursor` of the last answer. |
| `limit` | query | integer | (at most 500, default `100`) |

**Responses**

- `200`: The events.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `events` | array of [SyncEvent](#schema-syncevent) |  |
  | `nextCursor` | string |  |
  | `hasMore` | boolean |  |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.

## Directory

Browsing the public communities and people a server lists.

### GET /directory/communities

**Browse the public communities of a server**

The communities whose managers made them public, on this server or (with `domain`) another one, which this server asks on
your behalf: the other server never sees your address. A server that publishes no directory answers `directory_disabled`.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `q` | query | string | Search words. |
| `cursor` | query | string | The `nextCursor` of the last page. |
| `domain` | query | string | Another server to browse. |

**Responses**

- `200`: A page.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `items` | array of [DirectoryCommunity](#schema-directorycommunity) |  |
  | `nextCursor` | string or null |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `directory_disabled`.
- `502`: `federation_unreachable`.

### GET /directory/people

**Browse the people a server lists**

People who chose to be listed, and can be found by other servers. Otherwise like the communities directory.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `q` | query | string | Search words. |
| `cursor` | query | string |  |
| `domain` | query | string | Another server to browse. |

**Responses**

- `200`: A page.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `items` | array of [DirectoryPerson](#schema-directoryperson) |  |
  | `nextCursor` | string or null |  |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `directory_disabled`.
- `502`: `federation_unreachable`.

## Voice

Voice channels and calls (when the server has voice).

### GET /conversations/voice

**Calls going on in your chats**

Who is in a call, for each of your chats that has one. `available: false` means "not known" (no voice here, or the voice server did not answer), never "no calls".

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Responses**

- `200`: The calls.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `available` | boolean |  |
  | `calls` | object | By chat id: the ids of the people in the call. |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.

### POST /conversations/{id}/voice-token

**Join the call in a chat**

A pass for the chat's room on the voice server, for the voice client to connect with. Only for a chat whose members are all
on this server. Valid for 10 minutes to start a connection; it can only listen and publish a microphone.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `200`: The pass.

  Content type `application/json`.

  [VoiceToken](#schema-voicetoken)

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `404`: `not_found`, or `voice_not_enabled` on a server without voice.
- `409`: `voice_not_available_for_remote_conversation`.

### POST /channels/{id}/voice-token

**Join a voice channel**

A pass for the channel's room on the voice server, for the voice client to connect with. Needs the Connect to voice channels
permission, and the community must be hosted on this server. Valid for 10 minutes to start a connection; it can only listen
and publish a microphone.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `200`: The pass.

  Content type `application/json`.

  [VoiceToken](#schema-voicetoken)

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `forbidden`: you do not have the permission this needs (or it is not yours).
- `404`: `not_found`, or `voice_not_enabled` on a server without voice.
- `409`: `not_a_voice_channel` or `voice_not_available_for_remote_community`.

### GET /communities/{id}/voice

**Who is in a community's voice channels**

From the voice server itself. `available: false` means "not known" (no voice here, a community on another server, or the voice server did not answer), never "nobody".

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `200`: The people in each voice channel.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `available` | boolean |  |
  | `channels` | object | By channel id: the ids of the people in it. |

- `401`: `missing_token` or `invalid_token`: no access token, or one that is wrong or expired.
- `403`: `not_a_member`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### POST /voice/webhook

**Voice server to this server: something happened in a room**

**Not for clients.** The LiveKit server calls this when someone joins, leaves or publishes in a room, and this server then
tells the right people who is in it. It is believed only if it carries a signature made with the shared secret over the exact
body (`Authorization`, content type `application/webhook+json`).

**Needs sign-in:** no.

**Request body**

Content type `application/webhook+json`.

LiveKit's webhook event.

**Responses**

- `200`: Taken (also for events that are ignored).
- `401`: `invalid_signature`.
- `404`: `voice_not_enabled`.

## Administration

The admin page's API. For admins only, and invisible to everyone else (see the note on each).

### GET /admin/me

**Whether you can use the admin page**

**For admins only, and invisible to everyone else:** a signed-out visitor, a wrong token, an ordinary account, a suspended or erased
one, and any account on a server with `ADMIN_ENABLED=false` all get `404 not_found`, exactly what a path that does not exist gives, so
nobody can tell this API is there. An account is an admin only when the operator's command (`users make-admin`) made it one; nothing
in the API can.

Answers without two-factor sign-in so the page can tell the admin what is missing: everything else under `/admin` needs it.

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Responses**

- `200`: You are an admin.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `admin` | boolean | Required. |
  | `twoFactor` | boolean | Required. Whether two-factor sign-in is on. Without it the rest of `/admin` answers 403 `admin_requires_two_factor`. |

- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### GET /admin/audit-log

**Everything that was done (the audit log)**

The audit log, newest first: every moderation action in every community on this server (kicks, bans, roles, channels, a moderator
removing someone's message, ownership, deleting a community) and what operators did (the admin command, this page, the worker that
erases accounts). An entry holds who did it, what it was done to, where, when, and a few plain facts: **never what anyone wrote**
(no message text, no ban reason), a password or a token. It cannot be changed through the API; entries go only when they are older
than `AUDIT_LOG_RETENTION_DAYS`, and a person's name goes from them when their account is erased.

**For admins only, and invisible to everyone else** (see `GET /admin/me`). Needs two-factor sign-in (403 `admin_requires_two_factor`).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `before` | query | integer | Only entries older than this id: the `next` of the page before. (at least 1) |
| `limit` | query | integer | (at least 1, at most 200, default `50`) |
| `action` | query | string | One action, such as `member.ban`. |
| `source` | query | `api` \| `admin` \| `cli` \| `system` |  |
| `community` | query | string | A community's id. |
| `actor` | query | string | The id of whoever did it. |
| `target` | query | string | The id of what it was done to. |

**Responses**

- `200`: A page of entries.

  Content type `application/json`.

  [AuditPage](#schema-auditpage)

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `403`: `admin_requires_two_factor`: turn on two-factor sign-in first.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### POST /admin/sudo

**Confirm it is you (sudo mode)**

Everything on the admin page that changes something needs a recent proof that the person at the keyboard is the admin, so a stolen
session alone cannot do it. This takes the admin's password and a code from their authenticator (or one recovery code; each code works
once) and answers with a token good for **ten minutes**, to send in the `X-Admin-Sudo` header. The token names this admin: another
admin's is no good, and it cannot be mistaken for an access token or any other. The page keeps it in memory only.

Behind the sign-in rate limit: it is a way to guess a password.
For admins only, and invisible to everyone else (see `GET /admin/me`). Needs two-factor sign-in (403 `admin_requires_two_factor`).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `password` | string | Required. |
| `code` | string | From the authenticator app. Needed unless `recoveryCode` is given. |
| `recoveryCode` | string |  |

**Responses**

- `200`: Confirmed.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `sudoToken` | string | Required. |
  | `expiresAt` | string | Required. |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `401`: `invalid_credentials` (a wrong password) or `invalid_code`.
- `403`: `admin_requires_two_factor`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### GET /admin/users

**The accounts on this server**

The accounts on THIS server, oldest first, a page at a time: what an admin needs to decide what to do, and never a password hash, a 2FA
secret, a recovery code or a token. A cached copy of someone on another server, and an account that was erased, are not listed.
For admins only, and invisible to everyone else (see `GET /admin/me`). Needs two-factor sign-in (403 `admin_requires_two_factor`).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `search` | query | string | Part of a username or display name, in any case, taken literally (a % or _ is not a wildcard). (at most 100 characters) |
| `suspended` | query | boolean | true: only suspended accounts. |
| `admin` | query | boolean | true: only admins. false: only those who are not. |
| `offset` | query | integer | (at least 0, default `0`) |
| `limit` | query | integer | (at least 1, at most 100, default `25`) |

**Responses**

- `200`: A page.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `users` | array of [AdminUser](#schema-adminuser) | Required. |
  | `total` | integer | Required. How many match in all. |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `403`: `admin_requires_two_factor`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### GET /admin/users/{username}

**One account**

One account on this server: the list's fields plus when it was suspended, whether deletion was asked for and when it will happen,
how many sessions it has, the communities it owns, and the note on the registration invite it joined with. No messages, direct
messages or files, and no secret.
For admins only, and invisible to everyone else (see `GET /admin/me`). Needs two-factor sign-in (403 `admin_requires_two_factor`).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `username` | path | string | Required. |

**Responses**

- `200`: The account.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `user` | [AdminUserDetail](#schema-adminuserdetail) | Required. |

- `403`: `admin_requires_two_factor`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### POST /admin/users/{username}/suspend

**Suspend an account**

Stops the account signing in or refreshing a session, and ends its sessions now. (An access token already issued is good for at most 15 minutes.)
Needs **sudo mode**: a token from `POST /admin/sudo`, sent in the `X-Admin-Sudo` header (403 `sudo_required` without a valid one).
An account that is an admin cannot be changed this way (409 `target_is_admin`): taking admin away is the one change the page makes to one, and everything else is the command's.
For admins only, and invisible to everyone else (see `GET /admin/me`). Needs two-factor sign-in (403 `admin_requires_two_factor`).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `username` | path | string | Required. |

**Responses**

- `200`: Done. The account as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `user` | [AdminUserDetail](#schema-adminuserdetail) | Required. |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `403`: `sudo_required`, or `admin_requires_two_factor`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `target_is_admin`.

### POST /admin/users/{username}/unsuspend

**Unsuspend an account**

Lets the account sign in again. Its old sessions stay ended.
Needs **sudo mode**: a token from `POST /admin/sudo`, sent in the `X-Admin-Sudo` header (403 `sudo_required` without a valid one).
An account that is an admin cannot be changed this way (409 `target_is_admin`): taking admin away is the one change the page makes to one, and everything else is the command's.
For admins only, and invisible to everyone else (see `GET /admin/me`). Needs two-factor sign-in (403 `admin_requires_two_factor`).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `username` | path | string | Required. |

**Responses**

- `200`: Done. The account as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `user` | [AdminUserDetail](#schema-adminuserdetail) | Required. |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `403`: `sudo_required`, or `admin_requires_two_factor`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `target_is_admin`.

### POST /admin/users/{username}/reset-password

**Set a new password**

Sets the password the admin typed (held to the sign-up rules) and ends every session of the account. The password is never recorded in the audit log.
Needs **sudo mode**: a token from `POST /admin/sudo`, sent in the `X-Admin-Sudo` header (403 `sudo_required` without a valid one).
An account that is an admin cannot be changed this way (409 `target_is_admin`): taking admin away is the one change the page makes to one, and everything else is the command's.
For admins only, and invisible to everyone else (see `GET /admin/me`). Needs two-factor sign-in (403 `admin_requires_two_factor`).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `username` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `password` | string | Required. At least 8 characters with an uppercase letter, a lowercase letter, a number and a symbol. |

**Responses**

- `200`: Done. The account as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `user` | [AdminUserDetail](#schema-adminuserdetail) | Required. |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `403`: `sudo_required`, or `admin_requires_two_factor`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `target_is_admin`.

### POST /admin/users/{username}/disable-2fa

**Turn off two-factor sign-in**

For someone locked out of their account: turns it off and deletes their recovery codes. Their sessions are left alone.
Needs **sudo mode**: a token from `POST /admin/sudo`, sent in the `X-Admin-Sudo` header (403 `sudo_required` without a valid one).
An account that is an admin cannot be changed this way (409 `target_is_admin`): taking admin away is the one change the page makes to one, and everything else is the command's.
For admins only, and invisible to everyone else (see `GET /admin/me`). Needs two-factor sign-in (403 `admin_requires_two_factor`).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `username` | path | string | Required. |

**Responses**

- `200`: Done. The account as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `user` | [AdminUserDetail](#schema-adminuserdetail) | Required. |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `403`: `sudo_required`, or `admin_requires_two_factor`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `target_is_admin`.

### POST /admin/users/{username}/cancel-deletion

**Take a deletion back**

Cancels a pending request to delete the account, without waiting for the person to sign in.
Needs **sudo mode**: a token from `POST /admin/sudo`, sent in the `X-Admin-Sudo` header (403 `sudo_required` without a valid one).
An account that is an admin cannot be changed this way (409 `target_is_admin`): taking admin away is the one change the page makes to one, and everything else is the command's.
For admins only, and invisible to everyone else (see `GET /admin/me`). Needs two-factor sign-in (403 `admin_requires_two_factor`).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `username` | path | string | Required. |

**Responses**

- `200`: Done. The account as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `user` | [AdminUserDetail](#schema-adminuserdetail) | Required. |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `403`: `sudo_required`, or `admin_requires_two_factor`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `target_is_admin`.

### POST /admin/users/{username}/delete

**Delete an account**

Asks for the account to be deleted, as the person could: its sessions end and, after the grace period (`ACCOUNT_DELETION_GRACE_DAYS`), it is erased unless they sign in first. With `now` it is erased **at once**, which cannot be undone and also needs `confirm` to be the account's username. Refused while it owns a community.
Needs **sudo mode**: a token from `POST /admin/sudo`, sent in the `X-Admin-Sudo` header (403 `sudo_required` without a valid one).
An account that is an admin cannot be changed this way (409 `target_is_admin`): taking admin away is the one change the page makes to one, and everything else is the command's.
For admins only, and invisible to everyone else (see `GET /admin/me`). Needs two-factor sign-in (403 `admin_requires_two_factor`).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `username` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `now` | boolean | Erase at once. |
| `confirm` | string | The account's username, typed out. Needed with `now`. |

**Responses**

- `200`: Asked for: the account as it is now. Or, with `now`, `{ erased: true }`: it is gone.

  Content type `application/json`.

  One of:

  1.

     | Field | Type | Description |
     |---|---|---|
     | `user` | [AdminUserDetail](#schema-adminuserdetail) | Required. |

  2.

     | Field | Type | Description |
     |---|---|---|
     | `erased` | boolean | Required. |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `403`: `sudo_required`, or `admin_requires_two_factor`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `target_is_admin`. `owns_communities` (with `communities`: the ones to hand on or delete first). Also `400 confirm_mismatch`.

### PUT /admin/users/{username}/admin

**Make someone an admin, or take it away**

The one change the page makes to an admin account. Never your own (409 `cannot_change_own_admin`, which also means the last admin cannot be
removed from here) and not for someone who is suspended (409 `target_suspended`). Giving it twice or taking it twice changes nothing more.
The first admin is made by the operator's command, which is also the only way to make one on a server that has none. Someone made an admin
still has to turn on two-factor sign-in before the page opens for them.

Needs **sudo mode**: a token from `POST /admin/sudo`, sent in the `X-Admin-Sudo` header (403 `sudo_required` without a valid one).
For admins only, and invisible to everyone else (see `GET /admin/me`). Needs two-factor sign-in (403 `admin_requires_two_factor`).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `username` | path | string | Required. |

**Request body**

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `admin` | boolean | Required. |

**Responses**

- `200`: Done. The account as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `user` | [AdminUserDetail](#schema-adminuserdetail) | Required. |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `403`: `sudo_required`, or `admin_requires_two_factor`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).
- `409`: `cannot_change_own_admin` or `target_suspended`.

### GET /admin/registration-invites

**Registration invites**

The codes an invite-only server asks for (`REGISTRATION_INVITE_ONLY`), newest first: by default the ones that can still be used, with `all`
also the revoked, expired and used up. At most 200 are answered; `total` is how many matched. Each says how often it was used, when it ends,
the admin's note and the usernames that joined with it. A code is a credential (whoever has it can make an account), so it is shown only here
and is never in the audit log. `registration` says whether the codes matter right now: they are only asked for when registration is on and the
server is invite-only.
For admins only, and invisible to everyone else (see `GET /admin/me`). Needs two-factor sign-in (403 `admin_requires_two_factor`).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `all` | query | boolean | true: also the revoked, expired and used up. |

**Responses**

- `200`: The invites.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `invites` | array of [RegistrationInvite](#schema-registrationinvite) | Required. |
  | `total` | integer | Required. How many matched in all. |
  | `registration` | object | Required. |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `403`: `admin_requires_two_factor`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### POST /admin/registration-invites

**Make registration invites**

Makes `count` new codes with the same limits, each recorded in the audit log on its own (the entry names the invite by its id and the last four
characters of the code, never the code or the note). Leaving out `maxUses` or `expiresInDays` means one use and 7 days; `null` means no limit.
Needs **sudo mode**: a token from `POST /admin/sudo`, sent in the `X-Admin-Sudo` header (403 `sudo_required` without a valid one).
For admins only, and invisible to everyone else (see `GET /admin/me`). Needs two-factor sign-in (403 `admin_requires_two_factor`).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Request body** (optional)

Content type `application/json`.

| Field | Type | Description |
|---|---|---|
| `maxUses` | integer or null | How many accounts a code can make. null: any number. (at least 1, at most 10000, default `1`) |
| `expiresInDays` | integer or null | Days until it ends. null: never. (at least 1, at most 3650, default `7`) |
| `note` | string or null | A reminder of who it is for. Never shown to the person using it. (at most 100 characters) |
| `count` | integer | (at least 1, at most 50, default `1`) |

**Responses**

- `201`: Made.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `invites` | array of [RegistrationInvite](#schema-registrationinvite) | Required. |

- `400`: `invalid_request`: the body, a parameter or a query is not what the operation takes.
- `403`: `sudo_required`, or `admin_requires_two_factor`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

### POST /admin/registration-invites/{id}/revoke

**Revoke a registration invite**

Stops a code from being used. People who already made an account with it keep theirs. Revoking one that is already revoked changes nothing and
is not recorded again. The invite is named by its `id`, never by its code.
Needs **sudo mode**: a token from `POST /admin/sudo`, sent in the `X-Admin-Sudo` header (403 `sudo_required` without a valid one).
For admins only, and invisible to everyone else (see `GET /admin/me`). Needs two-factor sign-in (403 `admin_requires_two_factor`).

**Needs sign-in:** yes (`Authorization: Bearer <access token>`).

**Parameters**

| Name | In | Type | Description |
|---|---|---|---|
| `id` | path | string | Required. |

**Responses**

- `200`: Done. The invite as it is now.

  Content type `application/json`.

  | Field | Type | Description |
  |---|---|---|
  | `invite` | [RegistrationInvite](#schema-registrationinvite) | Required. |

- `403`: `sudo_required`, or `admin_requires_two_factor`.
- `404`: `not_found`: there is no such thing, or you are not allowed to know about it (a chat or community you are not in looks the same).

## Schemas

### Schema Error

| Field | Type | Description |
|---|---|---|
| `error` | string | Required. A stable code, such as `not_found`. |
| `details` | object | For `invalid_request` on some operations, what was wrong. |
| `message` | string |  |

### Schema SignedIn

| Field | Type | Description |
|---|---|---|
| `user` | [PublicUser](#schema-publicuser) | Required. |
| `accessToken` | string | Required. |
| `refreshToken` | string | Required. |
| `deletionCancelled` | boolean | Only present when this sign-in cancelled a request to delete the account (see `POST /users/me/delete`). |

### Schema TotpChallenge

| Field | Type | Description |
|---|---|---|
| `totpRequired` | boolean | Required. |
| `challengeToken` | string | Required. Good for a few minutes, only for `POST /auth/2fa/login`. |

### Schema Presence

| Field | Type | Description |
|---|---|---|
| `status` | `ONLINE` \| `AWAY` \| `BUSY` \| `DO_NOT_DISTURB` \| `INVISIBLE` \| `OFFLINE` | Required. |
| `customStatus` | string or null | Required. |
| `lastSeenAt` | string or null | Required. |

### Schema PublicUser

A person. Fields that are only for yourself are left out of everyone else's.

| Field | Type | Description |
|---|---|---|
| `id` | string | Required. Their id. |
| `identity` | string | Required. `@username:domain`. |
| `username` | string | Required. |
| `displayName` | string | Required. |
| `avatarUrl` | string or null | Required. |
| `bio` | string or null | Required. |
| `pronouns` | string or null | Required. |
| `accentColor` | string or null | Required. |
| `presence` | [Presence](#schema-presence) | Required. |
| `totpEnabled` | boolean | Only for you. |
| `discoverable` | boolean | Only for you. |
| `discoverabilityLocked` | boolean | Only for you: the server has taken the choice away. |
| `contactPolicy` | `ANYONE` \| `SHARED_COMMUNITY` \| `LOCAL_ONLY` | Only for you. |
| `contactPolicyLimit` | `ANYONE` \| `SHARED_COMMUNITY` \| `LOCAL_ONLY` | Only for you: the widest this server lets it be. |
| `listedInDirectory` | boolean | Only for you. |
| `isAdmin` | boolean | Only for you: whether you may use the admin page (and it is switched on). Only the operator's command can make someone one. |
| `directoryEnabled` | boolean | Only for you: whether the server has a directory. |
| `directoryPeopleLocked` | boolean | Only for you: the server lists nobody. |

### Schema AuditEntry

| Field | Type | Description |
|---|---|---|
| `id` | integer | Required. Increases with time: use it as the cursor. |
| `at` | string | Required. |
| `source` | `api` \| `admin` \| `cli` \| `system` | Required. `api`: a person using the app. `admin`: the admin page. `cli`: the operator's command. `system`: the server itself. |
| `action` | string | Required. A stable name such as `member.ban`, `role.update`, `user.suspend`, `account.erase`. |
| `actor` | object | Required. |
| `community` | object or null | Required. |
| `target` | object or null | Required. |
| `details` | object | Required. A few plain facts (which fields changed, a role's name): strings, numbers, booleans and short lists of strings. Never what anyone wrote. |

### Schema AuditPage

| Field | Type | Description |
|---|---|---|
| `entries` | array of [AuditEntry](#schema-auditentry) | Required. |
| `next` | integer or null | Required. Pass as `before` for the next page; null at the end. |

### Schema AdminUser

An account on this server, as the admin page lists it. Never a secret.

| Field | Type | Description |
|---|---|---|
| `id` | string | Required. Their id, which is also how the audit log names them. |
| `username` | string | Required. |
| `identity` | string | Required. |
| `displayName` | string | Required. |
| `createdAt` | string | Required. |
| `lastSeenAt` | string or null | Required. |
| `twoFactor` | boolean | Required. |
| `suspended` | boolean | Required. |
| `admin` | boolean | Required. |
| `deletionPending` | boolean | Required. Deletion was asked for and the grace period is running. |
| `communitiesOwned` | integer | Required. |
| `communitiesJoined` | integer | Required. Includes the ones they own. |

### Schema AdminUserDetail

One account, with what an admin needs to act on it.

Everything in [AdminUser](#schema-adminuser), and:

| Field | Type | Description |
|---|---|---|
| `suspendedAt` | string or null | Required. |
| `deletionRequestedAt` | string or null | Required. |
| `deletionScheduledFor` | string or null | Required. When it will be erased unless they sign in first. |
| `activeSessions` | integer | Required. Sessions that could still be refreshed. |
| `ownedCommunities` | array of object | Required. |
| `registrationInviteNote` | string or null | Required. The note on the registration invite they joined with, if they used one. |

### Schema RegistrationInvite

A code that lets someone make an account on an invite-only server.

| Field | Type | Description |
|---|---|---|
| `id` | string | Required. |
| `code` | string | Required. The code the person types on the register screen (10 characters, any case). A credential. |
| `note` | string or null | Required. |
| `status` | `active` \| `revoked` \| `expired` \| `used_up` | Required. Revoked beats expired beats used up. |
| `uses` | integer | Required. |
| `maxUses` | integer or null | Required. null: no limit. |
| `expiresAt` | string or null | Required. null: never. |
| `revokedAt` | string or null | Required. |
| `createdAt` | string | Required. |
| `joined` | array of string | Required. Usernames of the accounts made with it. An erased account is not named. |

### Schema UserProfile

| Field | Type | Description |
|---|---|---|
| `user` | [PublicUser](#schema-publicuser) | Required. |
| `memberSince` | string or null | Required. |
| `homeServerReachable` | boolean | Required. False when their own server could not be asked and this is the copy already held. |
| `relationship` | object | Required. |

### Schema FriendRequest

| Field | Type | Description |
|---|---|---|
| `id` | string | Required. |
| `from` | [PublicUser](#schema-publicuser) | Required. |
| `to` | [PublicUser](#schema-publicuser) | Required. |
| `message` | string or null | Required. |
| `status` | `PENDING` \| `ACCEPTED` \| `DECLINED` \| `CANCELLED` | Required. |
| `createdAt` | string | Required. |

### Schema ConversationMember

Everything in [PublicUser](#schema-publicuser), and:

| Field | Type | Description |
|---|---|---|
| `nickname` | string or null |  |

### Schema Conversation

| Field | Type | Description |
|---|---|---|
| `id` | string | Required. |
| `type` | `DM` \| `GROUP` | Required. |
| `title` | string or null | Required. |
| `createdAt` | string | Required. |
| `members` | array of [ConversationMember](#schema-conversationmember) | Required. |
| `lastMessage` | [Message](#schema-message) or null | Only in the list of chats. |
| `unread` | boolean | Only in the list of chats. |

### Schema AttachmentInput

A file already uploaded with `POST /media/upload` (which answers with exactly this).

| Field | Type | Description |
|---|---|---|
| `url` | string | Required. |
| `filename` | string | Required. |
| `contentType` | string | Required. |
| `size` | integer | Required. (at least 0) |

### Schema Attachment

Everything in [AttachmentInput](#schema-attachmentinput), and:

| Field | Type | Description |
|---|---|---|
| `id` | string | Required. |

### Schema Reaction

One kind of reaction on a message, with how many people made it.

| Field | Type | Description |
|---|---|---|
| `emoji` | string | A Unicode emoji. Absent for a custom emoticon. |
| `emoticon` | object | A custom emoticon, drawn from its picture (its trigger means different things to different people, so is never used). |
| `count` | integer | Required. |
| `users` | array of string | Required. Their usernames. |

### Schema MessageEmoticon

A custom emoticon used in the text of a message, so a client can draw it.

| Field | Type | Description |
|---|---|---|
| `id` | string |  |
| `trigger` | string |  |
| `imageUrl` | string |  |
| `name` | string |  |
| `allowSave` | boolean |  |
| `creatorId` | string |  |

### Schema InviteCard

A community invitation carried by a direct message. The name is whatever the community was called when it was sent: show it as text only.

| Field | Type | Description |
|---|---|---|
| `communityId` | string |  |
| `domain` | string | The server the community lives on. |
| `name` | string |  |
| `code` | string | The invite it hands over. A card from before invites has none. |

### Schema Message

| Field | Type | Description |
|---|---|---|
| `id` | string | Required. |
| `sender` | [PublicUser](#schema-publicuser) | Required. |
| `content` | string or null | Required. Null once deleted. |
| `invite` | [InviteCard](#schema-invitecard) or null | Required. |
| `emoticons` | array of [MessageEmoticon](#schema-messageemoticon) | Required. |
| `attachments` | array of [Attachment](#schema-attachment) | Required. |
| `embeds` | array of [Embed](#schema-embed) | Required. Link previews, when this server does them: see `Embed`. They arrive after the message, as the `message:embeds` event. |
| `replyTo` | null or object | Required. |
| `reactions` | array of [Reaction](#schema-reaction) | Required. |
| `editedAt` | string or null | Required. |
| `deletedAt` | string or null | Required. |
| `createdAt` | string | Required. |

### Schema Embed

A link preview: what the message's own server read from a page the message links to. Plain text only, cut to length (title 150
characters, description 300, site name 60) and never HTML; show the address's own host beside it, since the text is the page's
claim. At most 3 to a message. Shown only while this server does link previews.

| Field | Type | Description |
|---|---|---|
| `url` | string | Required. The page's address, as typed in the message (an absolute http or https address). |
| `title` | string or null | Required. |
| `description` | string or null | Required. |
| `siteName` | string or null | Required. |

### Schema Channel

| Field | Type | Description |
|---|---|---|
| `id` | string | Required. |
| `name` | string | Required. |
| `topic` | string or null | Required. |
| `type` | `TEXT` \| `VOICE` | Required. |
| `position` | integer | Required. |
| `unread` | boolean | Whether you have unread messages. Only where it is about you. |

### Schema PermissionBits

A set of permissions as a decimal number, one bit each, as a string (it can be larger than a JSON number holds). 1 Manage
community, 2 Manage roles, 4 Manage channels, 8 Manage emoticons, 16 Kick members, 32 Ban members, 64 Delete messages,
128 Send messages, 256 React, 512 Create invites, 1024 Connect to voice channels. Add the numbers of the ones wanted.

Type: string

### Schema Role

| Field | Type | Description |
|---|---|---|
| `id` | string | Required. |
| `name` | string | Required. |
| `color` | string or null | Required. |
| `position` | integer | Required. |
| `permissions` | [PermissionBits](#schema-permissionbits) | Required. |
| `isDefault` | boolean | Required. The role everyone has (`@everyone`). |

### Schema CommunityMember

Everything in [PublicUser](#schema-publicuser), and:

| Field | Type | Description |
|---|---|---|
| `nickname` | string or null | Required. |
| `joinedAt` | string | Required. |
| `roles` | array of string | Required. Role names. |
| `roleIds` | array of string | Required. |

### Schema Community

| Field | Type | Description |
|---|---|---|
| `id` | string | Required. |
| `name` | string | Required. |
| `description` | string or null | Required. |
| `iconUrl` | string or null | Required. |
| `iconText` | string or null | Required. 1 to 3 characters shown on the tile when there is no picture. |
| `iconColor` | string or null | Required. `#rrggbb`. |
| `visibility` | `UNLISTED` \| `INVITE_ONLY` \| `LOCAL_ONLY` \| `PUBLIC` | Who can join, held to the server's limit. |
| `visibilityLimit` | `UNLISTED` \| `INVITE_ONLY` \| `LOCAL_ONLY` \| `PUBLIC` | The most exposed a community may be on this server. |
| `openJoin` | boolean | The old yes/no, still sent. |
| `homeserverDomain` | string | Required. The server it lives on. With `id`, what to give to join it from anywhere. |
| `owner` | [PublicUser](#schema-publicuser) | Required. |
| `createdAt` | string | Required. |
| `channels` | array of [Channel](#schema-channel) | Required. |
| `roles` | array of [Role](#schema-role) | Required. |
| `members` | array of [CommunityMember](#schema-communitymember) | Required. |

### Schema CommunityBan

| Field | Type | Description |
|---|---|---|
| `user` | [PublicUser](#schema-publicuser) | Required. |
| `reason` | string or null | Required. |
| `createdAt` | string | Required. |

### Schema Invite

| Field | Type | Description |
|---|---|---|
| `id` | string or null | Required. What to revoke it by. Null for one made through another server, which only that server can list or revoke. |
| `code` | string | Required. |
| `reference` | string | Required. Everything to paste into "Join by ID": `<community id>:<server>#<code>`. |
| `expiresAt` | string or null | Required. |
| `maxUses` | integer or null | Required. |
| `uses` | integer | Required. |
| `revokedAt` | string or null | Required. |
| `viaCard` | boolean | Required. Made for a card sent to a friend. |
| `status` | `active` \| `revoked` \| `expired` \| `used_up` | Required. |
| `createdAt` | string | Required. |
| `createdBy` | [PublicUser](#schema-publicuser) | Required. |

### Schema Emoticon

| Field | Type | Description |
|---|---|---|
| `id` | string | Required. |
| `name` | string | Required. |
| `trigger` | string | Required. |
| `imageUrl` | string | Required. |
| `creator` | [PublicUser](#schema-publicuser) | Required. |
| `communityId` | string or null | Required. |
| `allowSave` | boolean | Required. |
| `allowExport` | boolean | Required. |
| `allowFork` | boolean | Required. |
| `parentId` | string or null | Required. |
| `parent` | null or object |  |
| `createdAt` | string | Required. |

### Schema NotificationSetting

| Field | Type | Description |
|---|---|---|
| `type` | `GLOBAL` \| `COMMUNITY` \| `CHANNEL` \| `CONVERSATION` | Required. |
| `id` | string or null | Required. The place's id; null for the global setting. |
| `sound` | boolean or null | Required. `null`: no choice here, use the next level up. |
| `notify` | boolean or null | Required. |

### Schema SyncEvent

| Field | Type | Description |
|---|---|---|
| `id` | string | Required. |
| `type` | string | Required. Such as `message:created`, `community:updated`. |
| `payload` | object | Required. |
| `createdAt` | string | Required. |

### Schema DirectoryCommunity

| Field | Type | Description |
|---|---|---|
| `id` | string | Required. |
| `domain` | string | Required. |
| `name` | string | Required. |
| `description` | string or null | Required. |
| `iconUrl` | string or null | Required. |
| `iconText` | string or null | Required. |
| `iconColor` | string or null | Required. |
| `memberCount` | integer | Required. |

### Schema DirectoryPerson

| Field | Type | Description |
|---|---|---|
| `id` | string | Required. |
| `username` | string | Required. |
| `domain` | string | Required. |
| `displayName` | string | Required. |
| `avatarUrl` | string or null | Required. |
| `bio` | string or null | Required. |

### Schema VoiceToken

| Field | Type | Description |
|---|---|---|
| `url` | string | Required. The voice server to connect to (ws or wss). |
| `token` | string | Required. A signed pass for one room. |
| `room` | string | Required. |
| `identity` | string | Required. Who you are in the room (your id). |
| `expiresInSeconds` | integer | Required. |
