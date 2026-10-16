# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers
follow the policy in [docs/versioning.md](docs/versioning.md).

Entries from `0.1.0` onward are generated automatically by
[release-please](https://github.com/googleapis/release-please) from
Conventional Commit PR titles - see `docs/versioning.md` for how a release
actually gets cut. Don't hand-edit below this point; a manual edit would just get
overwritten by the next generated entry.

## [0.14.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.13.0...v0.14.0) (2026-10-16)


### Added

* a community's managers choose who may join it, including only people on its own server ([#109](https://github.com/sam-bowman/federated-chat-app/issues/109) phase 4) ([#187](https://github.com/sam-bowman/federated-chat-app/issues/187)) ([1c6da73](https://github.com/sam-bowman/federated-chat-app/commit/1c6da7397c996a6b2459e5e2a6b003ec02de239e))
* a person can hide from other servers ([#109](https://github.com/sam-bowman/federated-chat-app/issues/109) phase 3, who can find me) ([#185](https://github.com/sam-bowman/federated-chat-app/issues/185)) ([5763e01](https://github.com/sam-bowman/federated-chat-app/commit/5763e018cf42d10d5cc0aada78cf7d7964ca5476))
* a person chooses who may send them friend requests and start conversations ([#109](https://github.com/sam-bowman/federated-chat-app/issues/109) phase 3b) ([#186](https://github.com/sam-bowman/federated-chat-app/issues/186)) ([1e65926](https://github.com/sam-bowman/federated-chat-app/commit/1e65926f65b99caa6d0a00715bd9c41827399df7))
* a server can publish a directory of public communities and of people who chose to be listed ([#109](https://github.com/sam-bowman/federated-chat-app/issues/109) phase 5) ([#190](https://github.com/sam-bowman/federated-chat-app/issues/190)) ([8786975](https://github.com/sam-bowman/federated-chat-app/commit/87869758bf0b13ddca3babfbcbe101ece7e64a90))
* **client:** insert emoticons at the cursor, with ':' suggestions and a searchable emoticon picker ([#192](https://github.com/sam-bowman/federated-chat-app/issues/192)) ([49d0f05](https://github.com/sam-bowman/federated-chat-app/commit/49d0f05d590abf5da8c997cf5cb8a6f9f99bb4a8))
* **client:** make, list and revoke invites; invite-only communities; cards say why they fail ([#179](https://github.com/sam-bowman/federated-chat-app/issues/179)) ([2d1b43b](https://github.com/sam-bowman/federated-chat-app/commit/2d1b43bfc22a85082301ce61e38c80fe6ddcf350)), closes [#168](https://github.com/sam-bowman/federated-chat-app/issues/168)
* FEDERATION_ALLOWED_DOMAINS / FEDERATION_BLOCKED_DOMAINS limit which servers it talks to ([#109](https://github.com/sam-bowman/federated-chat-app/issues/109) phase 2) ([#184](https://github.com/sam-bowman/federated-chat-app/issues/184)) ([c4ff673](https://github.com/sam-bowman/federated-chat-app/commit/c4ff673969035d5e1a1bff5e2979dddb161d1c7b))
* FEDERATION_ENABLED makes a server private ([#109](https://github.com/sam-bowman/federated-chat-app/issues/109) phase 1) ([#180](https://github.com/sam-bowman/federated-chat-app/issues/180)) ([1e552e2](https://github.com/sam-bowman/federated-chat-app/commit/1e552e28a60739d05604b5080bea0f5539952fe3))
* react with a custom emoticon, shown as its picture to everyone, across servers ([#193](https://github.com/sam-bowman/federated-chat-app/issues/193)) ([371c440](https://github.com/sam-bowman/federated-chat-app/commit/371c4403ac324ed5a02bd6131558bda4bf8c7813))
* server defaults and limits for who may contact people, community visibility and listing people ([#189](https://github.com/sam-bowman/federated-chat-app/issues/189)) ([#191](https://github.com/sam-bowman/federated-chat-app/issues/191)) ([ae4b6f2](https://github.com/sam-bowman/federated-chat-app/commit/ae4b6f267344b11b56defd9ca9dd1bbd3cb93f9d))


### Fixed

* **client:** don't draw a live message twice when the history already loaded it ([#181](https://github.com/sam-bowman/federated-chat-app/issues/181)) ([8357f52](https://github.com/sam-bowman/federated-chat-app/commit/8357f5220f705ff840eb9871b0f52b2f7e59da56))
* **client:** keep a message that arrives while the history is loading ([#182](https://github.com/sam-bowman/federated-chat-app/issues/182)) ([34789c2](https://github.com/sam-bowman/federated-chat-app/commit/34789c25080accab653b1735010c40a804fa1605))
* **client:** no gap between the tabs and their panel inside a dialog ([#177](https://github.com/sam-bowman/federated-chat-app/issues/177)) ([32179c3](https://github.com/sam-bowman/federated-chat-app/commit/32179c3e0640642f6641eca5cb04e3f308fb4cea))
* **server:** keep values from outside out of log format strings ([#188](https://github.com/sam-bowman/federated-chat-app/issues/188)) ([bb69bd0](https://github.com/sam-bowman/federated-chat-app/commit/bb69bd085ac07c68d7a096c7f8515ed85837cf44))

## [0.13.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.12.0...v0.13.0) (2026-10-15)


### Added

* **client:** an in-app colour picker, and modals that behave like dialogs ([#167](https://github.com/sam-bowman/federated-chat-app/issues/167)) ([c9a777b](https://github.com/sam-bowman/federated-chat-app/commit/c9a777b1c22a68557667aedd9fc07f3017fa2763)), closes [#143](https://github.com/sam-bowman/federated-chat-app/issues/143)
* **client:** bigger avatars, a wider resizable sidebar, and your own status kept current ([#172](https://github.com/sam-bowman/federated-chat-app/issues/172)) ([e25d0a0](https://github.com/sam-bowman/federated-chat-app/commit/e25d0a044d76a50244c75df0eefb52c1a9eb2c4d))
* **client:** choose the interface font in Settings -&gt; Appearance ([#175](https://github.com/sam-bowman/federated-chat-app/issues/175)) ([018ff74](https://github.com/sam-bowman/federated-chat-app/commit/018ff7419dc95fe45a71ee589e04c1ba37d510b2)), closes [#114](https://github.com/sam-bowman/federated-chat-app/issues/114)
* **client:** choose the interface size in Settings -&gt; Appearance ([#174](https://github.com/sam-bowman/federated-chat-app/issues/174)) ([8c701d3](https://github.com/sam-bowman/federated-chat-app/commit/8c701d3ef438ec13b115595f38149c775cbdf7f9))
* **client:** one set of buttons across the app, with a Button component and a guard test ([#165](https://github.com/sam-bowman/federated-chat-app/issues/165)) ([6ae46ad](https://github.com/sam-bowman/federated-chat-app/commit/6ae46ad1bd9538e9cb02c67c303f0e99a87295c0)), closes [#141](https://github.com/sam-bowman/federated-chat-app/issues/141)
* **client:** one Tabs component with a bordered panel and keyboard navigation ([#166](https://github.com/sam-bowman/federated-chat-app/issues/166)) ([39a2c1e](https://github.com/sam-bowman/federated-chat-app/commit/39a2c1e7968395566dd70437d7426fac68975c58))
* **client:** show a channel's topic in the header and as a sidebar tooltip ([#163](https://github.com/sam-bowman/federated-chat-app/issues/163)) ([16a5819](https://github.com/sam-bowman/federated-chat-app/commit/16a5819b723ee0b65a3a442fe3ac55dac3ba3aba)), closes [#144](https://github.com/sam-bowman/federated-chat-app/issues/144)
* **client:** show your status in the footer and change it from there ([#171](https://github.com/sam-bowman/federated-chat-app/issues/171)) ([040b5bc](https://github.com/sam-bowman/federated-chat-app/commit/040b5bc5d8a114176f0bf62c82b67fa255838ebd)), closes [#148](https://github.com/sam-bowman/federated-chat-app/issues/148)
* customise a community's icon: a picture, or letters and a colour ([#170](https://github.com/sam-bowman/federated-chat-app/issues/170)) ([dbc3559](https://github.com/sam-bowman/federated-chat-app/commit/dbc3559c84f59672f9046cc6da080a0786ca7ea9)), closes [#147](https://github.com/sam-bowman/federated-chat-app/issues/147)
* invite friends to a community from the app, with a card and a Join button in the DM ([#169](https://github.com/sam-bowman/federated-chat-app/issues/169)) ([6577e27](https://github.com/sam-bowman/federated-chat-app/commit/6577e27f81f37737c4237c370b874e8189166515)), closes [#146](https://github.com/sam-bowman/federated-chat-app/issues/146)
* invites that expire, have use limits and can be revoked (server) ([#176](https://github.com/sam-bowman/federated-chat-app/issues/176)) ([58012d1](https://github.com/sam-bowman/federated-chat-app/commit/58012d164b4649df9adb271fe4b2c9aaf37c00ea))
* viewable, customisable user profiles ([#173](https://github.com/sam-bowman/federated-chat-app/issues/173)) ([4a53692](https://github.com/sam-bowman/federated-chat-app/commit/4a536923cea236b81d2f002df4b9108fd66a8a4a)), closes [#150](https://github.com/sam-bowman/federated-chat-app/issues/150)


### Fixed

* **chart:** refuse several server replicas on a ReadWriteOnce uploads volume, and document running more than one ([#161](https://github.com/sam-bowman/federated-chat-app/issues/161)) ([4aa5990](https://github.com/sam-bowman/federated-chat-app/commit/4aa5990801a0d46b57583afb8cf0a4d2ab4808cd)), closes [#151](https://github.com/sam-bowman/federated-chat-app/issues/151)
* **client:** don't serve a blank page mid-rollout when a hashed asset is on another pod, and add settings for several client replicas ([#164](https://github.com/sam-bowman/federated-chat-app/issues/164)) ([8bb8c64](https://github.com/sam-bowman/federated-chat-app/commit/8bb8c6451e25ead90b1ab5832f4fe314b8ab5b07))
* **client:** show only an explanation and Close when there is nobody to transfer a community to ([#159](https://github.com/sam-bowman/federated-chat-app/issues/159)) ([69750f2](https://github.com/sam-bowman/federated-chat-app/commit/69750f2a1d68c4cc74d05283325aa7646079b157)), closes [#145](https://github.com/sam-bowman/federated-chat-app/issues/145)
* **client:** stop friend-search results sticking over the box, and stop listing people who can't be added ([#157](https://github.com/sam-bowman/federated-chat-app/issues/157)) ([642193c](https://github.com/sam-bowman/federated-chat-app/commit/642193c0dad3c39ea6a8fcea102b75d885690407)), closes [#140](https://github.com/sam-bowman/federated-chat-app/issues/140)
* **server:** keep users online when another replica restarts, and shut down gracefully ([#162](https://github.com/sam-bowman/federated-chat-app/issues/162)) ([cf3aea4](https://github.com/sam-bowman/federated-chat-app/commit/cf3aea46942a49747f5490da57fdee776b40e16b)), closes [#160](https://github.com/sam-bowman/federated-chat-app/issues/160)

## [0.12.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.11.0...v0.12.0) (2026-10-14)


### Added

* **client:** readable account footer and a distinct community rail ([#121](https://github.com/sam-bowman/federated-chat-app/issues/121)) ([171613f](https://github.com/sam-bowman/federated-chat-app/commit/171613f46eca9237531ae9e577344ee9637bcc99))
* **client:** remember servers and usernames and offer them on the sign-in page ([#119](https://github.com/sam-bowman/federated-chat-app/issues/119)) ([68ad3bd](https://github.com/sam-bowman/federated-chat-app/commit/68ad3bd47bd831fc51d9f04dccdb9007eb858803))
* **client:** show community settings to members with delegated permissions ([#123](https://github.com/sam-bowman/federated-chat-app/issues/123)) ([f5aae97](https://github.com/sam-bowman/federated-chat-app/commit/f5aae976f9fc640a192483b243aac6cdc89cc1ef)), closes [#72](https://github.com/sam-bowman/federated-chat-app/issues/72)
* **communities:** let owners transfer or delete a community ([#130](https://github.com/sam-bowman/federated-chat-app/issues/130)) ([f40bce8](https://github.com/sam-bowman/federated-chat-app/commit/f40bce8b4ef709a412c4caf06c60f09d4f6c2212)), closes [#127](https://github.com/sam-bowman/federated-chat-app/issues/127)
* react with any Unicode emoji from a searchable picker ([#125](https://github.com/sam-bowman/federated-chat-app/issues/125)) ([1f37bc1](https://github.com/sam-bowman/federated-chat-app/commit/1f37bc135dafbfe85bf2c01c408a5532c32eb81c))
* show the client and home server versions in Settings ([#122](https://github.com/sam-bowman/federated-chat-app/issues/122)) ([8c79edd](https://github.com/sam-bowman/federated-chat-app/commit/8c79edd10d0b51dc00e05d76f582768b069f2a76))


### Fixed

* **client:** keep password managers out of ordinary text boxes ([#129](https://github.com/sam-bowman/federated-chat-app/issues/129)) ([6b398f0](https://github.com/sam-bowman/federated-chat-app/commit/6b398f0493b43412430b3f3ad579dea57f71fbe2))
* **federation:** deliver to peers in the background so a dead peer cannot slow a send ([#139](https://github.com/sam-bowman/federated-chat-app/issues/139)) ([c9d5f17](https://github.com/sam-bowman/federated-chat-app/commit/c9d5f1734cdeffe504e303e35cf6c553da78fd84)), closes [#138](https://github.com/sam-bowman/federated-chat-app/issues/138)
* **scripts:** make start.ps1 generate the Prisma client and only report success when the app answers ([#124](https://github.com/sam-bowman/federated-chat-app/issues/124)) ([af66329](https://github.com/sam-bowman/federated-chat-app/commit/af66329bf7934eb51dd7be8dc04bc2428e0b8a03)), closes [#86](https://github.com/sam-bowman/federated-chat-app/issues/86) [#87](https://github.com/sam-bowman/federated-chat-app/issues/87)
* **server:** never let a test run reset a database that isn't a test database ([#131](https://github.com/sam-bowman/federated-chat-app/issues/131)) ([7165b3c](https://github.com/sam-bowman/federated-chat-app/commit/7165b3c75664cd8f4446c36b867de53e4b3e904b))

## [0.11.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.10.0...v0.11.0) (2026-10-14)


### Added

* **client:** let browsers and password managers fill the sign-in form ([#117](https://github.com/sam-bowman/federated-chat-app/issues/117)) ([0e4e00c](https://github.com/sam-bowman/federated-chat-app/commit/0e4e00cc8b1ac987ebf01cc6e1f9c2a4c4c6b86e))


### Fixed

* **client:** keep the composer pinned to the bottom in an empty chat ([#116](https://github.com/sam-bowman/federated-chat-app/issues/116)) ([54e7a50](https://github.com/sam-bowman/federated-chat-app/commit/54e7a5098ba7d8a499d3be81615272f10383208d)), closes [#115](https://github.com/sam-bowman/federated-chat-app/issues/115)

## [0.10.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.9.0...v0.10.0) (2026-10-13)


### ⚠ BREAKING CHANGES

* **server:** the Docker image no longer creates a missing database on start. Create it yourself, or set CREATE_DATABASE_IF_MISSING=true.
* **server:** CORS_ORIGIN=* is no longer accepted; list the specific origins instead, e.g. CORS_ORIGIN=https://chat.example.com,http://tauri.localhost.

### Added

* **chart:** keep the data volumes when a release is uninstalled ([#91](https://github.com/sam-bowman/federated-chat-app/issues/91)) ([fab69c5](https://github.com/sam-bowman/federated-chat-app/commit/fab69c53c9272d281164dc1d24a0246b4eeac323)), closes [#84](https://github.com/sam-bowman/federated-chat-app/issues/84)
* **chart:** make the uploads volume writable by default, and document Longhorn storage ([#101](https://github.com/sam-bowman/federated-chat-app/issues/101)) ([dd768d0](https://github.com/sam-bowman/federated-chat-app/commit/dd768d080a402298f4c5f2f54ca7d1ac03c55416))
* **chart:** run behind a Traefik ingress, with a TRUST_PROXY setting ([#100](https://github.com/sam-bowman/federated-chat-app/issues/100)) ([e6d3c0d](https://github.com/sam-bowman/federated-chat-app/commit/e6d3c0dfe44f3058e6417e89a2f042b0b9d277b4)), closes [#96](https://github.com/sam-bowman/federated-chat-app/issues/96)
* **communities:** enforce DELETE_MESSAGES, REACT and MANAGE_EMOTICONS ([#107](https://github.com/sam-bowman/federated-chat-app/issues/107)) ([7f3c7bc](https://github.com/sam-bowman/federated-chat-app/commit/7f3c7bc7b46f58f5727325d05a342f9d92d841cf))
* **server:** let CORS_ORIGIN list more than one origin ([#95](https://github.com/sam-bowman/federated-chat-app/issues/95)) ([0170c89](https://github.com/sam-bowman/federated-chat-app/commit/0170c89d029c7cd89ca4f1c48a209e9822867fb0))
* **server:** refuse to start with insecure defaults or against a newer database ([#94](https://github.com/sam-bowman/federated-chat-app/issues/94)) ([ee38aef](https://github.com/sam-bowman/federated-chat-app/commit/ee38aef97f895a3a75aa3c985020533ce545fdf5)), closes [#77](https://github.com/sam-bowman/federated-chat-app/issues/77) [#83](https://github.com/sam-bowman/federated-chat-app/issues/83)


### Fixed

* **dev:** pin the dev Compose project name so start.ps1 works from any folder ([#90](https://github.com/sam-bowman/federated-chat-app/issues/90)) ([3ecc98f](https://github.com/sam-bowman/federated-chat-app/commit/3ecc98f489224e28dba2cd557d58f348a6b2f854)), closes [#88](https://github.com/sam-bowman/federated-chat-app/issues/88)
* **server:** answer an error in an async route with a 500 instead of crashing the server ([#93](https://github.com/sam-bowman/federated-chat-app/issues/93)) ([1fc208b](https://github.com/sam-bowman/federated-chat-app/commit/1fc208b7162fc03f47172dada2e58ec246ac4e18))
* **server:** refuse a database that does not exist instead of silently creating it ([#106](https://github.com/sam-bowman/federated-chat-app/issues/106)) ([6def51d](https://github.com/sam-bowman/federated-chat-app/commit/6def51d7118faa2353b76c9e74c7feefc6aabd2b)), closes [#80](https://github.com/sam-bowman/federated-chat-app/issues/80)
* **server:** repair local accounts the old migrations tagged 'localhost' ([#104](https://github.com/sam-bowman/federated-chat-app/issues/104)) ([ff0d0d4](https://github.com/sam-bowman/federated-chat-app/commit/ff0d0d41fd1355bee39ee8a41804e18ec6a77b8c)), closes [#78](https://github.com/sam-bowman/federated-chat-app/issues/78)
* **server:** restore plain express Routers so CodeQL sees the rate limiter again ([#98](https://github.com/sam-bowman/federated-chat-app/issues/98)) ([a76b868](https://github.com/sam-bowman/federated-chat-app/commit/a76b86834a98f683257b3447da665c13ff9aa460))
* **server:** stop accepting CORS_ORIGIN=* (any origin) ([#99](https://github.com/sam-bowman/federated-chat-app/issues/99)) ([12107a2](https://github.com/sam-bowman/federated-chat-app/commit/12107a2a3b3208f2dc0cbfeb81eaac178527320f))

## [0.9.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.8.0...v0.9.0) (2026-10-12)


### Added

* **client:** page back through message history with a Load older button ([#65](https://github.com/sam-bowman/federated-chat-app/issues/65)) ([40a9ae1](https://github.com/sam-bowman/federated-chat-app/commit/40a9ae1face07728ac4a48ac15a9a0d95264b76f)), closes [#50](https://github.com/sam-bowman/federated-chat-app/issues/50)
* **communities:** manage roles from the UI, and close two role escalation holes ([#71](https://github.com/sam-bowman/federated-chat-app/issues/71)) ([6bdaf74](https://github.com/sam-bowman/federated-chat-app/commit/6bdaf742bb21c1bcf5decbbbdaa73ccab1e3aa42))
* **communities:** rename, reorder and delete channels ([#74](https://github.com/sam-bowman/federated-chat-app/issues/74)) ([c001974](https://github.com/sam-bowman/federated-chat-app/commit/c001974f6629b679f31ea0f9c8e77466b02c64b5)), closes [#57](https://github.com/sam-bowman/federated-chat-app/issues/57)
* **emoticons:** fork an emoticon from the UI, and sync a fork with its original ([#68](https://github.com/sam-bowman/federated-chat-app/issues/68)) ([f76cab5](https://github.com/sam-bowman/federated-chat-app/commit/f76cab5cdf14933a01ce2795acf1635127ccc337)), closes [#51](https://github.com/sam-bowman/federated-chat-app/issues/51)
* **emoticons:** let the owner choose whether others can save or fork it ([#70](https://github.com/sam-bowman/federated-chat-app/issues/70)) ([d164208](https://github.com/sam-bowman/federated-chat-app/commit/d164208a679ca1a285f9548cb86022723bb6a6aa)), closes [#52](https://github.com/sam-bowman/federated-chat-app/issues/52)
* **emoticons:** let the owner edit an emoticon's name and image ([#69](https://github.com/sam-bowman/federated-chat-app/issues/69)) ([f5ca847](https://github.com/sam-bowman/federated-chat-app/commit/f5ca847838f6c8c7c95c6d687943029a53ed0577)), closes [#67](https://github.com/sam-bowman/federated-chat-app/issues/67)

## [0.8.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.7.0...v0.8.0) (2026-10-10)


### Added

* **auth:** add TOTP-based two-factor authentication ([#34](https://github.com/sam-bowman/federated-chat-app/issues/34)) ([05876b1](https://github.com/sam-bowman/federated-chat-app/commit/05876b1a52ad5cd618e8b52762f573649e0b1d24))
* **client:** add a community members panel with kick/ban/unban ([#43](https://github.com/sam-bowman/federated-chat-app/issues/43)) ([581fa1a](https://github.com/sam-bowman/federated-chat-app/commit/581fa1a28b36f0b59266e29ae8ae85b6c135804a))
* **federation:** authorize and persist remote member writes to communities ([#40](https://github.com/sam-bowman/federated-chat-app/issues/40)) ([99ca4b2](https://github.com/sam-bowman/federated-chat-app/commit/99ca4b289d50a23af4931cf3193c7d78f64a12fc))
* **federation:** support group DMs spanning multiple domains ([#36](https://github.com/sam-bowman/federated-chat-app/issues/36)) ([45f09e9](https://github.com/sam-bowman/federated-chat-app/commit/45f09e9c988332c087dfb51ac8eb0e16b25561bc))
* **federation:** support joining, leaving, and reading remote communities ([#37](https://github.com/sam-bowman/federated-chat-app/issues/37)) ([0174fa8](https://github.com/sam-bowman/federated-chat-app/commit/0174fa8ce74280555f41115c3603622e67a8ecae))

## [0.7.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.6.0...v0.7.0) (2026-10-09)


### Added

* **auth:** require stronger passwords and check against known breaches ([#33](https://github.com/sam-bowman/federated-chat-app/issues/33)) ([d8d0c38](https://github.com/sam-bowman/federated-chat-app/commit/d8d0c38351da69633142590e4b28ee3c5165851c))
* **federation:** add replay protection via a nonce cache ([#30](https://github.com/sam-bowman/federated-chat-app/issues/30)) ([3fbcf66](https://github.com/sam-bowman/federated-chat-app/commit/3fbcf6662937fc721bba69ed4bbab268e0b716b6))
* **federation:** propagate remote message edit/delete/reactions ([#32](https://github.com/sam-bowman/federated-chat-app/issues/32)) ([fbaa8aa](https://github.com/sam-bowman/federated-chat-app/commit/fbaa8aa20bad8d710b4020d1294bcf7ba89c1838))

## [0.6.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.5.1...v0.6.0) (2026-10-09)


### Added

* add a Helm chart for Kubernetes deployment ([#26](https://github.com/sam-bowman/federated-chat-app/issues/26)) ([c066275](https://github.com/sam-bowman/federated-chat-app/commit/c0662753dceaf8e4455315a3968ccd6f321c8a1f))
* add docker-compose.yml for self-hosting ([#24](https://github.com/sam-bowman/federated-chat-app/issues/24)) ([5915d1f](https://github.com/sam-bowman/federated-chat-app/commit/5915d1fad7e3299fcee884c0e91ccb62a444d3ce))
* add S3-compatible object storage abstraction ([#27](https://github.com/sam-bowman/federated-chat-app/issues/27)) ([8cff55c](https://github.com/sam-bowman/federated-chat-app/commit/8cff55c507d8f979507237777910acf075ddc862))
* **federation:** add a durable outbox with retry and backfill ([#28](https://github.com/sam-bowman/federated-chat-app/issues/28)) ([f851d20](https://github.com/sam-bowman/federated-chat-app/commit/f851d20565454d904bfaeac5576ec01bc8a6cc5d))

## [0.5.1](https://github.com/sam-bowman/federated-chat-app/compare/v0.5.0...v0.5.1) (2026-10-08)


### Fixed

* resolve critical SSRF and 49 missing-rate-limiting CodeQL alerts ([#21](https://github.com/sam-bowman/federated-chat-app/issues/21)) ([9eeab6b](https://github.com/sam-bowman/federated-chat-app/commit/9eeab6bdc7f1c800be993d3a1d3b68f715e33d40))

## [0.5.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.4.0...v0.5.0) (2026-10-08)


### Added

* **client:** add a desktop app via Tauri ([#19](https://github.com/sam-bowman/federated-chat-app/issues/19)) ([cc8b788](https://github.com/sam-bowman/federated-chat-app/commit/cc8b7882cc074e0b22386affc1cd0258e1b02857))

## [0.4.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.3.1...v0.4.0) (2026-10-08)


### Added

* **client:** add a home-server picker before login ([#14](https://github.com/sam-bowman/federated-chat-app/issues/14)) ([856cfdb](https://github.com/sam-bowman/federated-chat-app/commit/856cfdb36e5275c2f969738899e795c0c82442f6))
* **client:** package the web client as a native binary ([#16](https://github.com/sam-bowman/federated-chat-app/issues/16)) ([9250bac](https://github.com/sam-bowman/federated-chat-app/commit/9250bac1c6f7a28251f946038b274ab99b7d07e7))
* **server:** package the server as a native binary ([#17](https://github.com/sam-bowman/federated-chat-app/issues/17)) ([369b258](https://github.com/sam-bowman/federated-chat-app/commit/369b25898b83250c1585f84c60acb33eccb6b448))

## [0.3.1](https://github.com/sam-bowman/federated-chat-app/compare/v0.3.0...v0.3.1) (2026-10-07)


### Fixed

* **client:** stop multi-arch Docker build hanging on arm64 ([#12](https://github.com/sam-bowman/federated-chat-app/issues/12)) ([41fad0e](https://github.com/sam-bowman/federated-chat-app/commit/41fad0ea81d42023c51b9950b4f200bccd4fbf94))

## [0.3.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.2.0...v0.3.0) (2026-10-07)


### Added

* publish multi-arch (amd64/arm64) Docker images ([#10](https://github.com/sam-bowman/federated-chat-app/issues/10)) ([17ac28d](https://github.com/sam-bowman/federated-chat-app/commit/17ac28d259bd836d6218208817d8e555d158606b))

## [0.2.0](https://github.com/sam-bowman/federated-chat-app/compare/v0.1.0...v0.2.0) (2026-10-07)


### Added

* add Dockerfiles and publish images to GHCR on release ([#8](https://github.com/sam-bowman/federated-chat-app/issues/8)) ([8e2af5b](https://github.com/sam-bowman/federated-chat-app/commit/8e2af5b5fbe58ceded914cf59c38e2c5ac9350ae))
* **server:** add Redis-backed cross-replica presence/WS fan-out ([#4](https://github.com/sam-bowman/federated-chat-app/issues/4)) ([0e0cc87](https://github.com/sam-bowman/federated-chat-app/commit/0e0cc872e210e3717e5f55b9ec4dfc66d2907cd4))

## [0.1.0] - 2026-10-07

First documented baseline, written by hand before release-please existed - a
retrospective summary of everything shipped before this file started being
kept. Every entry after this one is generated automatically.

### Added

- Core single-server platform: `@username:domain` identity, registration,
  login with JWT access/refresh tokens, friends (requests, friendships,
  blocking), presence (online/away/busy/DND/invisible/offline + custom
  status), 1:1 and group DMs, communities with channels/roles/permissions,
  personal and community emoticons with saving and forking, and an offline
  delivery outbox (`SyncEvent`) so clients catch up on reconnect.
- Server discovery via `GET /.well-known/communication-platform`.
- Real server-to-server federation between independently-run homeservers:
  signed Ed25519 HTTP requests, peer discovery and caching, federated friend
  requests, 1:1 DMs, and live presence. See README "Architecture notes —
  federation" and "Known federation limitations" for what federation
  deliberately doesn't cover yet (group DMs/communities, remote
  edit/delete/reaction propagation, a durable retry queue).
- Redis-backed cross-replica presence/WebSocket fan-out, opt-in via
  `REDIS_URL` - lets more than one server replica run behind a load
  balancer with correct realtime delivery and fleet-wide presence tracking.
  A single replica never touches Redis.
- Full automated test suite: unit tests for pure logic (identity parsing,
  federation request signing, permission bitmasks, serialization) and
  integration tests running the real app against real Postgres and Redis,
  including several regression tests written directly against bugs found
  during manual testing (see Fixed, below) and a cross-replica fan-out proof.
- CI pipeline (lint, typecheck+build, unit/integration tests with an
  enforced coverage floor, `npm audit`, dependency review, secret scanning,
  CodeQL) gating all merges to `master` via a branch ruleset.
- Local dev tooling: `scripts/start.ps1`/`stop.ps1` for a single instance,
  `scripts/start-federation-demo.ps1`/`stop-federation-demo.ps1` for two
  independent homeservers talking to each other.
- Issue and PR templates, `CLAUDE.md`, `ROADMAP.md`, and an MIT `LICENSE`.

### Changed

- Redesigned the message list to a Discord-style full-width layout (was
  chat bubbles).

### Fixed

- Presence getting stuck permanently online after logout, and (separately)
  stuck offline after a WebSocket reconnect used an unrefreshed access
  token.
- Emoticons being invisible to message recipients (resolved against the
  wrong user's accessible set).
- Messages from one conversation/channel briefly appearing in a different,
  unrelated open thread.
- `publicUser()` leaking a user's true `INVISIBLE` presence status to
  anyone fetching it over REST, even though the live WebSocket broadcast
  already masked it as `OFFLINE` - found while writing the test suite
  above, not from manual testing.

### Security

- Federation requests are signed (Ed25519) and verified, with timestamp-based
  replay protection and conversation-membership checks on inbound messages.
- CI enforces `npm audit`, GitHub Dependency Review, gitleaks secret
  scanning, and CodeQL static analysis on every change.
