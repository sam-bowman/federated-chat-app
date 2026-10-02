# Federated Open-Source Communication Platform
## Product & Technical Architecture Specification

### 1. Project Overview

Build an open-source, federated communication platform combining:

- The community/server model of Discord
- The persistent friend and private messaging experience of classic MSN Messenger
- Self-hosting similar to Mumble, TeamSpeak, Matrix, or XMPP
- Globally addressable user identities
- Federated communication between independently operated servers
- User-created and collectible custom emoticons
- Text, presence, media, and voice communication
- A public/default service that anyone can use without self-hosting
- The ability for technically capable users, communities, organizations, or companies to operate their own servers

The platform must **not depend on a single centrally operated service**.

The official project may operate a public server/provider for convenience, but this server is only one participant in the network.

The software, client, server, and federation protocol should be open source.

---

# 2. Core Design Principle

The system must distinguish between four concepts:

1. **Identity**
2. **Homeserver / Provider**
3. **Private social communication**
4. **Communities**

These must not be tightly coupled.

A user's identity belongs to a homeserver, but their social relationships and community memberships may span the entire federated network.

Conceptually:

```text
                         FEDERATED NETWORK
                                │
             ┌──────────────────┼──────────────────┐
             │                  │                  │
        Homeserver A       Homeserver B       Homeserver C
             │                  │                  │
          Users              Users              Users
             │                  │                  │
             └──────────── Federation ─────────────┘
                                │
                ┌───────────────┴────────────────┐
                │                                │
           Private Social                    Communities
                │                                │
           Friends / DMs                 Channels / Roles
           Presence                      Permissions
           Emoticons                     Voice
```

The end user should not need to understand federation.

They should simply be able to sign up, add friends, send messages, and join communities.

---

# 3. User Experience

A normal user should be able to visit a public server such as:

```text
chat.example.org
```

and register.

Their identity becomes something like:

```text
@sam:example.org
```

or another protocol-defined globally unique identifier.

After registration they should immediately be able to:

- Add friends
- Accept/decline friend requests
- Send private messages
- Create group DMs
- Create communities
- Join communities
- Create custom emoticons
- Save emoticons from other users
- Set presence/status
- Make voice calls
- Join community voice channels
- Share images/files
- Manage their profile

The UI should feel like a normal centralized messaging application.

Federation should be almost invisible.

---

# 4. Identity

Every user has a globally unique identity.

Recommended conceptual format:

```text
@username:homeserver.example
```

Example:

```text
@sam:example.org
@alice:alice.example
@bob:company.net
```

The homeserver portion is authoritative for the identity.

The identity must not depend on the user remaining on the same IP address or physical machine.

A homeserver is responsible for authenticating and signing actions originating from identities it controls.

---

# 5. Homeservers

A homeserver is an independently operated instance of the platform.

A homeserver provides:

- User registration
- Authentication
- Identity management
- User profiles
- Friend relationships
- Private messages
- Group DMs
- Presence
- Notification delivery
- User emoticons
- Saved emoticons
- Federation
- Community hosting
- Optional media storage
- Optional voice infrastructure

A deployment should ideally be possible using:

```text
Docker
Docker Compose
Kubernetes
Bare metal
VM
```

The initial release should preferably be a single deployable application rather than a large microservice architecture.

Internal modules can still have clean boundaries.

Example:

```text
server/
├── identity
├── authentication
├── federation
├── messaging
├── friends
├── presence
├── communities
├── emoticons
├── media
├── voice
├── moderation
└── storage
```

---

# 6. Public Server Model

The project may operate an official public homeserver.

For example:

```text
chat.example.org
```

Users can simply create accounts there.

However:

**The official server must not be technically required for the network to function.**

A third party must be able to deploy:

```text
chat.example.com
```

and participate in federation.

The official server is therefore a provider, not the authority over the network.

---

# 7. Federation

Federation allows independently operated homeservers to communicate.

Example:

```text
Alice
@alice:alice.example

          │
          │ federation
          ▼

Bob
@bob:bob.example
```

Alice must be able to:

- Discover Bob
- Send Bob a friend request
- Accept a friend request from Bob
- Send Bob DMs
- Exchange media
- See presence where permitted
- Participate in shared communities

without Alice creating an account on Bob's homeserver.

Federation must use authenticated server-to-server communication.

Every federated event/action must be attributable to an identity or server and must be cryptographically verifiable where appropriate.

---

# 8. Friend System

Friends are a first-class concept and are independent of communities.

A user can be friends with another user without sharing any communities.

Example:

```text
@sam:example.org
    │
    ├── Friend → @alice:alice.example
    ├── Friend → @bob:bob.net
    └── Friend → @charlie:company.org
```

Friend states should include at minimum:

```text
NONE
REQUESTED
PENDING
ACCEPTED
BLOCKED
```

A friend request should contain:

- Requesting identity
- Target identity
- Request ID
- Timestamp
- Optional message
- Cryptographic authentication/signature

Users must be able to:

- Accept
- Decline
- Cancel
- Remove friend
- Block
- Unblock

Privacy settings should determine who may send friend requests.

---

# 9. Private Messaging

Private messages are independent from communities.

A DM conversation may contain:

```text
1-to-1 conversation
```

or:

```text
Group conversation
```

A conversation has a stable unique ID.

Example:

```text
conversation:01JXYZ...
```

Messages should have globally unique IDs.

Example:

```text
message:01JXYZ...
```

Messages should contain at minimum:

```text
id
conversation_id
sender
timestamp
content
attachments
reply/reference information
edit information
deletion information
```

The protocol should support:

- Text
- Markdown or limited rich text
- Replies
- Reactions
- Editing
- Deletion
- Attachments
- Images
- Files
- Custom emoticons
- Link previews
- Typing indicators
- Read receipts
- Delivery state

The exact storage/replication model should be designed so that offline users receive messages when they reconnect.

---

# 10. End-to-End Encryption

The protocol should be designed so that end-to-end encryption can be supported.

Encryption should not be bolted on after the protocol is finalized.

However, encryption implementation should be approached carefully.

The architecture should distinguish:

```text
Transport encryption
```

from:

```text
End-to-end message encryption
```

TLS protects server-to-server/client-to-server connections.

E2EE protects message content from the homeservers themselves.

The initial implementation may launch without E2EE if necessary, but the protocol must avoid making future E2EE impossible.

Do not invent cryptography.

Use established cryptographic protocols and libraries.

---

# 11. Communities

A community is a separate logical object from a homeserver.

A community resembles a Discord server.

It can contain:

```text
Community
├── Members
├── Roles
├── Permissions
├── Text channels
├── Voice channels
├── Threads
├── Community emoticons
├── Moderation
├── Bans
└── Settings
```

A community should have its own unique globally addressable identifier.

Example:

```text
#retro-gaming:community.example
```

or another protocol-defined community ID.

---

# 12. Communities Must Support Cross-Homeserver Membership

This is essential.

A community may contain users from multiple homeservers.

Example:

```text
Retro Gaming

Members:

@sam:example.org
@alice:alice.example
@bob:company.net
@charlie:another.net
```

The community's hosting infrastructure maintains membership and permissions.

The users retain ownership of their identities through their respective homeservers.

Therefore:

```text
Community ≠ Homeserver
```

A homeserver may host communities, but a community should not inherently own its members' identities.

---

# 13. Community Ownership

A community must have:

- Owner
- Administrators
- Moderators
- Members
- Banned users
- Roles

Permissions should be granular.

Example:

```text
Owner
  ├── Manage Community
  ├── Manage Roles
  ├── Ban Members
  ├── Manage Channels
  └── Manage Emoticons

Moderator
  ├── Delete Messages
  ├── Timeout Members
  └── Ban Members

Member
  ├── Send Messages
  ├── React
  └── Join Voice
```

Permissions should be composable and role-based.

---

# 14. Community Discovery

Communities should be discoverable independently from user identity.

Potential discovery mechanisms:

- Direct invite
- Community URL
- Search
- Public directory
- QR code
- Invite code

A private community should not appear in public discovery.

Example:

```text
https://chat.example.org/community/retro-gaming
```

The URL should ultimately resolve to the community's globally identifiable object rather than tying it permanently to the hosting provider's domain.

---

# 15. Community Migration

The architecture should ideally allow a community to migrate between hosting infrastructure.

For example:

```text
gaming.example
       │
       │ migration
       ▼
newhost.example
```

The community identity should remain stable.

This should be considered in the data model from the beginning, even if actual migration tooling is implemented later.

---

# 16. Community Emoticons

Communities can have their own emoticon collection.

Example:

```text
Retro Gaming
├── :pog:
├── :gg:
├── :rip:
└── :speedrun:
```

Community emoticons are separate from personal emoticons.

Permissions should determine who can:

- Create
- Upload
- Delete
- Rename
- Manage

community emoticons.

---

# 17. Personal Emoticons

Users can create custom emoticons.

An emoticon should have:

```text
ID
Creator
Name
Trigger
Image/media
Creation timestamp
Version
Metadata
Permissions
```

Example:

```text
emote://example.org/01JXYZ
```

with:

```text
creator = @sam:example.org
name = smug-frog
trigger = :smugfrog:
```

---

# 18. Emoticon Saving / "Stealing"

One of the defining product features is the ability to save an emoticon received from another user.

For example:

```text
Alice sends:

      [custom frog image]

Right click:

Save Emoticon
```

The recipient gets a local reference/copy:

```text
Saved Emoticons
├── smug-frog
├── angry-cat
└── dancing-banana
```

The system should preserve provenance:

```text
Original creator:
@alice:alice.example

Original emoticon:
emote://alice.example/1234

Saved by:
@sam:example.org
```

This should make emoticon culture part of the product.

---

# 19. Emoticon Permissions

Creators should have control over how their emoticons can be reused.

Possible policies:

```text
ALLOW_SAVE
ALLOW_EXPORT
ALLOW_FORK
PRIVATE
```

For example:

```text
Personal Emoticon

[✓] Other users may save
[✓] Other users may use
[ ] Other users may fork
```

Communities may have their own policies.

---

# 20. Emoticon Forking

Users should optionally be able to modify a saved emoticon and create a new one.

Example:

```text
Alice's smug-frog
        │
        ▼
Sam's smug-frog-angry
```

The new emoticon maintains provenance:

```text
Parent:
emote://alice.example/1234

Creator:
@sam:example.org
```

This allows an informal lineage of emoticons.

---

# 21. Presence

Presence should be a first-class feature inspired by MSN.

States:

```text
ONLINE
AWAY
BUSY
DO_NOT_DISTURB
INVISIBLE
OFFLINE
```

Users can also have a custom status message.

Example:

```text
Sam
● Online

"Working on something stupid"
```

Presence should support privacy controls.

Users should be able to decide who can see:

- Online state
- Last seen
- Current activity
- Custom status
- Current community
- Typing state

---

# 22. MSN-Style Personal Features

The product should intentionally preserve some personality from classic instant messaging.

Potential features:

- Custom status messages
- Personal display names
- Rich presence
- Custom avatars
- Custom emoticons
- Saved emoticon collections
- Conversation-specific nicknames
- Typing indicators
- Read receipts
- Optional message sounds
- Nudges/buzzes
- Animated reactions
- "Now playing" / activity status
- User themes

These should remain optional and configurable.

The goal is not to recreate MSN's UI exactly.

The goal is to recreate the sense that **your personal identity and conversations belong to you**.

---

# 23. Voice

Communities should support voice channels.

Example:

```text
Retro Gaming
├── Text
│   ├── general
│   └── games
│
└── Voice
    ├── Lobby
    ├── Gaming
    └── AFK
```

Users should also be able to initiate direct voice calls from DMs.

Voice infrastructure should be separated conceptually from the messaging protocol.

WebRTC is a candidate technology for clients.

The architecture should allow a self-hosted deployment to operate its own voice/media infrastructure.

Avoid requiring a central media relay operated by the project.

---

# 24. Media and File Storage

Attachments should support:

- Images
- GIFs
- Video
- Audio
- Documents
- Custom emoticons
- Avatars

The server should be able to store media locally.

Storage should be abstracted behind a storage interface so deployments can use:

```text
Local filesystem
S3-compatible storage
MinIO
Cloud object storage
```

The protocol should reference media through stable identifiers rather than assuming a specific storage provider.

---

# 25. Client Applications

The project should have a reference client.

Initial target:

```text
Desktop
Web
```

Potential later targets:

```text
iOS
Android
```

The client should communicate with the homeserver through a documented API/protocol.

The client must not contain assumptions that the official homeserver is the only server.

A user should be able to enter/select their homeserver during login.

Example:

```text
Sign in

Username:
sam

Server:
example.org

[ Sign in ]
```

Advanced users could specify:

```text
https://chat.mycompany.com
```

---

# 26. Server Discovery

Clients should be able to discover homeserver capabilities.

For example:

```text
GET /.well-known/...
```

or an equivalent protocol mechanism.

The server should advertise:

- Protocol version
- Supported features
- Federation endpoint
- API endpoint
- Voice capabilities
- Media capabilities
- Registration policy
- Encryption capabilities

This allows clients to work with servers running different versions.

---

# 27. Federation Protocol

The federation protocol should be a formal, versioned specification.

It should define:

- Identity format
- Server discovery
- Authentication
- Server-to-server authentication
- Event format
- Message format
- Friend requests
- Friend acceptance
- Presence
- Communities
- Community membership
- Roles
- Permissions
- Media references
- Emoticons
- Deletion
- Editing
- Moderation
- Synchronization
- Offline delivery
- Error handling
- Version negotiation

The protocol must be documented independently of the reference server implementation.

This is important because third parties should be able to implement compatible servers.

---

# 28. Event-Based Architecture

Consider using an event-based protocol internally.

Examples:

```text
UserRegistered
FriendRequestCreated
FriendRequestAccepted
FriendRemoved
UserBlocked
MessageCreated
MessageEdited
MessageDeleted
ReactionAdded
CommunityCreated
MemberJoined
MemberRemoved
RoleCreated
RoleUpdated
ChannelCreated
EmoticonCreated
EmoticonSaved
PresenceChanged
```

Each event should have:

```text
event_id
event_type
origin
timestamp
payload
protocol_version
authentication/signature
```

This makes synchronization and federation easier to reason about.

---

# 29. Event IDs

Event IDs should be globally unique.

Do not rely solely on local auto-incrementing database IDs.

Use UUIDs, ULIDs, or another appropriate globally unique identifier.

The protocol should distinguish:

```text
Local database ID
```

from:

```text
Federated object/event ID
```

---

# 30. Ordering

Distributed systems cannot assume a single global message ordering.

The protocol should define ordering semantics explicitly.

For a conversation, clients should be able to determine:

- Event timestamp
- Causal relationship where relevant
- Message ordering
- Edit/delete relationships
- Reply relationships

Do not design the system around a globally synchronized clock.

---

# 31. Offline Operation

A major requirement is that users may be offline.

If:

```text
Alice offline
Bob sends message
```

then Alice should receive the message when her homeserver/client reconnects.

Homeservers should maintain sufficient state to perform synchronization.

Clients should have a synchronization mechanism such as:

```text
sync(cursor)
```

or an equivalent event-stream mechanism.

The protocol must support resumable synchronization.

---

# 32. Security

Security must be considered from the beginning.

Requirements include:

- TLS
- Secure password hashing
- Rate limiting
- Authentication tokens
- Session management
- Server authentication
- Federated request authentication
- Replay protection
- Permission checking
- Abuse prevention
- Spam prevention
- File upload validation
- Content-type validation
- Malware scanning hooks
- Audit logs for administrators
- Account recovery
- Optional 2FA

Never implement cryptography manually.

Use established libraries.

---

# 33. Moderation

Community administrators must have moderation tools.

At minimum:

- Delete message
- Timeout user
- Kick user
- Ban user
- Unban user
- Restrict channel
- Lock channel
- Manage roles
- Manage emoticons
- View moderation events

Moderation should be scoped appropriately.

A community administrator should not automatically gain control over a user's identity or private conversations elsewhere in the network.

---

# 34. Blocking

Blocking must operate at the user level.

If Sam blocks Alice:

```text
Sam
  │
  └── BLOCKED → Alice
```

The system should prevent or restrict:

- Friend requests
- DMs
- Presence visibility
- Calls
- Notifications

according to the user's privacy settings.

A community can independently ban Alice without affecting Alice's relationship with Sam elsewhere.

---

# 35. Privacy

Privacy settings should be granular.

Users should control:

```text
Who can add me?
Who can DM me?
Who can see my presence?
Who can see my last seen?
Who can call me?
Who can see my communities?
Who can save my emoticons?
```

Possible values:

```text
Everyone
Friends
Friends of Friends
Nobody
```

Community-level privacy settings should be separate.

---

# 36. Database

The reference implementation should use a relational database.

PostgreSQL is a strong candidate.

Core conceptual tables/entities:

```text
users
identities
sessions
friendships
friend_requests
blocks
conversations
conversation_members
messages
message_revisions
reactions
attachments
presence
communities
community_members
roles
permissions
channels
channel_members
community_bans
emoticons
emoticon_saves
emoticon_versions
events
federation_peers
```

The exact schema should be designed around the protocol rather than the UI.

---

# 37. Caching

Redis or an equivalent system may be used for:

- Presence
- Rate limits
- Sessions
- Temporary federation state
- Pub/sub
- WebSocket coordination

However, Redis should not become the source of truth for persistent data.

---

# 38. Real-Time Transport

Clients need real-time updates.

WebSockets are a strong candidate.

Possible architecture:

```text
Client
  │
  │ HTTPS
  ▼
API
  │
  ├── REST/HTTP
  │
  └── WebSocket
         │
         ▼
      Event stream
```

The protocol should remain transport-independent where practical.

---

# 39. API

The reference server should expose a documented API.

Potential API areas:

```text
/auth
/users
/friends
/conversations
/messages
/communities
/channels
/emoticons
/media
/presence
/federation
```

Use explicit versioning:

```text
/api/v1/...
```

Avoid tying the public protocol permanently to a framework-specific API implementation.

---

# 40. Server Administration

A server administrator should have a web-based administration interface.

Capabilities:

- User management
- Registration settings
- Federation settings
- Storage settings
- Media settings
- Voice settings
- Server bans
- Rate limits
- Logs
- Health
- Metrics
- Backup configuration
- Database management
- Federation peer status

---

# 41. Self-Hosting Experience

The self-hosting experience should be a major feature.

A technically competent user should be able to deploy the server with:

```bash
docker compose up -d
```

and then visit:

```text
https://chat.example.com/setup
```

The setup wizard should configure:

- Domain
- Database
- Admin account
- Federation
- Storage
- Registration
- Email
- Voice
- TLS/reverse proxy configuration

Provide a simple Docker deployment first.

Kubernetes/Helm can come later.

---

# 42. Configuration

Prefer a simple configuration file.

Example:

```yaml
server:
  domain: chat.example.com
  name: My Chat Server

database:
  url: postgres://...

registration:
  enabled: true

federation:
  enabled: true

media:
  backend: filesystem

voice:
  enabled: true
```

Secrets should be supplied through environment variables or secret management mechanisms rather than committed configuration.

---

# 43. Open Source

The project should be open source.

Ideally publish:

```text
Client
Server
Federation protocol
SDK
Documentation
Deployment configuration
```

The federation protocol should have its own specification.

Third-party implementations should be possible without reverse-engineering the reference implementation.

---

# 44. Repository Structure

A possible monorepo:

```text
project/
├── client/
│   ├── desktop/
│   └── web/
│
├── server/
│   ├── identity/
│   ├── auth/
│   ├── messaging/
│   ├── friends/
│   ├── communities/
│   ├── emoticons/
│   ├── presence/
│   ├── media/
│   ├── voice/
│   └── federation/
│
├── protocol/
│   ├── specification/
│   ├── schemas/
│   └── examples/
│
├── sdk/
│
├── deployment/
│   ├── docker/
│   └── kubernetes/
│
├── docs/
│
└── tests/
    ├── protocol/
    ├── federation/
    ├── server/
    └── client/
```

---

# 45. Testing Federation

Federation must be tested using multiple independent server instances.

The test environment should look like:

```text
Server A
  @alice

Server B
  @bob

Server C
  @charlie
```

Automated tests should verify:

```text
Alice → Bob friend request
Bob → Alice acceptance
Alice → Bob DM
Bob → Alice DM
Alice ↔ Bob presence
Alice + Bob → shared community
Alice → community message
Bob → community message
Alice → emoticon
Bob → save emoticon
Server A → Server B synchronization
Server failure → recovery
Offline user → synchronization
```

Do not only test federation using a single server pretending to be multiple servers.

Run genuine independent instances.

---

# 46. Failure Handling

Federation must tolerate temporary failures.

Example:

```text
Server A ─────X───── Server B
```

Messages/events should not simply disappear.

The system needs:

- Queuing
- Retry
- Backoff
- Idempotency
- Event IDs
- Deduplication
- Synchronization
- Recovery after downtime

Federation must be eventually consistent where appropriate.

---

# 47. Server Independence

No feature should silently call an official central API.

The reference client must communicate with the user's configured homeserver.

For example, avoid:

```text
Client → official.example.org → user's server
```

as a required architecture.

Prefer:

```text
Client → user's homeserver
                 │
                 └── federation → other homeservers
```

The official server is merely one possible homeserver.

---

# 48. Community Hosting Independence

Communities should ideally be able to run on a server different from their members.

Example:

```text
                 Community Host
              gaming.example.org
                       │
          ┌────────────┼────────────┐
          │            │            │
          ▼            ▼            ▼
      @sam:A       @alice:B      @bob:C
```

The community host manages community state.

The users' homeservers manage user identity and private social state.

---

# 49. Discovery vs Federation

Do not assume that federation requires a global centralized directory.

A user may discover someone through:

- Friend invite
- Community invite
- Username search on a known homeserver
- QR code
- Direct profile URL

A public directory can optionally exist, but it should not be required for federation.

---

# 50. URLs

Objects should have human-friendly URLs where possible.

Examples:

```text
https://example.org/@sam
https://example.org/community/retro-gaming
```

These URLs should resolve to globally identifiable objects.

A user profile URL should not imply that the website hosting the profile owns the identity.

---

# 51. Product Philosophy

The product should combine:

### Discord

- Communities
- Channels
- Roles
- Permissions
- Voice
- Moderation

### MSN Messenger

- Friends
- Personal identity
- Presence
- Private conversations
- Custom status
- Custom emoticons
- Emoticon saving
- Personal social experience

### Mumble / TeamSpeak

- Self-hosting
- Server ownership
- Low infrastructure dependency
- Community-controlled infrastructure

### Federated systems

- No central authority
- Multiple providers
- Cross-server communication
- Open protocol
- User portability

The resulting product should not be treated as a Discord clone.

The core product model is:

```text
                 PEOPLE
                   │
          ┌────────┴────────┐
          │                 │
       FRIENDS          COMMUNITIES
          │                 │
         DMs          Channels / Voice
          │                 │
          └────────┬────────┘
                   │
                IDENTITY
                   │
             HOMESERVER
                   │
              FEDERATION
```

---

# 52. Recommended Development Phases

## Phase 1 — Protocol Foundation

Build:

- Identity
- Homeserver
- Authentication
- Server discovery
- Federation authentication
- Basic event model
- Basic user profiles

Do not build the full UI first.

The protocol needs to be stable enough to support everything else.

---

## Phase 2 — Private Messaging

Implement:

- Friend requests
- Friends
- Blocks
- Presence
- 1-to-1 DMs
- Group DMs
- Message synchronization
- WebSockets
- Offline delivery

At this point two independent servers should be able to communicate.

---

## Phase 3 — Communities

Implement:

- Community creation
- Membership
- Roles
- Permissions
- Text channels
- Threads
- Moderation
- Community federation
- Community discovery/invites

---

## Phase 4 — Emoticon System

Implement:

- Personal emoticons
- Community emoticons
- Emoticon picker
- Saving emoticons
- Provenance
- Permissions
- Forking/versioning

This should be treated as a first-class feature rather than an afterthought.

---

## Phase 5 — Media

Implement:

- Image uploads
- File uploads
- GIFs
- Avatars
- Media storage abstraction
- S3-compatible storage

---

## Phase 6 — Voice

Implement:

- Community voice channels
- Direct voice calls
- WebRTC
- Self-hosted media infrastructure
- NAT traversal
- Optional TURN

---

## Phase 7 — Security / E2EE

Implement and thoroughly audit:

- Session security
- Federation authentication
- Account security
- Optional 2FA
- E2EE for private conversations
- Key management
- Device management

Use established cryptographic protocols and libraries.

---

# 53. Important Architectural Rules

The development team/AI agent should treat the following as hard requirements:

### Rule 1

**Never make the official project server a dependency of the protocol.**

### Rule 2

**Never equate a homeserver with a community.**

### Rule 3

**Never require users to have accounts on the same server to communicate.**

### Rule 4

**Never make friendships dependent on shared communities.**

### Rule 5

**Never make community membership transfer ownership of a user's identity.**

### Rule 6

**Design federation into the protocol from the beginning.**

### Rule 7

**Separate persistent protocol IDs from local database IDs.**

### Rule 8

**Design for offline operation and eventual synchronization.**

### Rule 9

**Do not invent cryptographic primitives.**

### Rule 10

**The client must work with arbitrary compatible homeservers.**

---

# 54. Reference Architecture

The target architecture should ultimately resemble:

```text
                         PUBLIC INTERNET
                                │
       ┌────────────────────────┼────────────────────────┐
       │                        │                        │
       ▼                        ▼                        ▼

┌───────────────┐        ┌───────────────┐        ┌───────────────┐
│ Homeserver A  │◄──────►│ Homeserver B  │◄──────►│ Homeserver C  │
│               │        │               │        │               │
│ @sam          │        │ @alice        │        │ @bob          │
│ @tom          │        │ @john         │        │ @mary         │
│               │        │               │        │               │
│ Friends       │        │ Friends       │        │ Friends       │
│ DMs           │        │ DMs           │        │ DMs           │
│ Presence      │        │ Presence      │        │ Presence      │
│ Emoticons     │        │ Emoticons     │        │ Emoticons     │
└───────┬───────┘        └───────┬───────┘        └───────┬───────┘
        │                         │                        │
        └─────────────────────────┼────────────────────────┘
                                  │
                           FEDERATED USERS
                                  │
                                  ▼
                         ┌──────────────────┐
                         │   Communities    │
                         │                  │
                         │ Retro Gaming     │
                         │ Linux            │
                         │ Friends          │
                         │ Work             │
                         └──────────────────┘
```

---

# 55. Final Goal

The finished platform should feel to a normal user like a single application:

> Sign up → add friends → message people → join communities → create communities → customize your identity → collect emoticons → talk in voice channels.

Underneath that simple experience is a decentralized/federated architecture:

> Anyone can operate a compatible homeserver, users retain identities associated with their chosen provider, communities can span homeservers, and servers communicate through an open protocol.

The project should therefore be designed as **an open communication protocol with a reference implementation and reference client**, rather than merely as a self-hosted web application.

The official service is a convenient entry point, not the foundation of the network.