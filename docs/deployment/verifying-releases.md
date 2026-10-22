# Verifying a release, and following security fixes

> Part of the [deployment guides](README.md).

How to check that what you run came from this project's own build, what is in it, whether it has known vulnerabilities, and how to hear
about fixes.

> **Status: not yet run against a real release.** The signed provenance and the lists of contents described here were added to the release
> workflows after the last release (v0.18.0), so **no published release has them yet**; releases up to and including v0.18.0 carry only
> the unsigned build record the Docker tooling adds by default. The commands below are the documented usage of the tools, run by the
> project's workflows on the **first release after this change**, and have not been run by hand against a published artifact. If one does
> not work, that is a bug: please open an issue. What *was* run is marked below.

## Does it come from this repository's build?

Each release's workflow signs a statement ("this file or image digest was built by this workflow, from this repository, at this commit")
using GitHub's artifact attestations. With the [GitHub CLI](https://cli.github.com):

```bash
# a Docker image (the tag you run, or its digest)
gh attestation verify oci://ghcr.io/sam-bowman/federated-chat-app-server:<version> --repo sam-bowman/federated-chat-app

# a native binary archive, from the release page
gh attestation verify federated-chat-app-server-<version>-linux-x64.tar.gz --repo sam-bowman/federated-chat-app
```

Success means the artifact is exactly what that workflow built. It does **not** mean the code is free of bugs or vulnerabilities, only
that nobody swapped the file between the build and you. Not covered yet: the desktop installers and the Helm chart (the installers are
also unsigned in the operating-system sense, see the project's issues); the desktop **updater** has its own signature check and is
separate.

## What is in it? (the software bill of materials)

- **Docker images** carry an SPDX list of the packages inside, attached to the image in the registry:

  ```bash
  docker buildx imagetools inspect ghcr.io/sam-bowman/federated-chat-app-server:<version> --format '{{ json .SBOM }}'
  ```

  (Run against a locally built image, the equivalent build options produced an SPDX document listing 72 packages for the client image
  and a SLSA provenance record next to it; that is the part that has been run.)
- **Native binaries** have a CycloneDX list of their production dependencies attached to the release as
  `federated-chat-app-<server|client>-<version>.sbom.cdx.json`.

Feed these to whatever you use to track vulnerabilities in what you run.

## Does it have known vulnerabilities?

The project scans its images before each release and every week (see [security.md](../security.md#image-scanning)), and only a
**CRITICAL** vulnerability that has a fix stops a release. You can look for yourself at the version you run:

```bash
docker run --rm aquasec/trivy image --ignore-unfixed --severity HIGH,CRITICAL ghcr.io/sam-bowman/federated-chat-app-server:<your tag>
docker run --rm aquasec/trivy image --ignore-unfixed --severity HIGH,CRITICAL ghcr.io/sam-bowman/federated-chat-app-client:<your tag>
```

An image that was clean when released is not clean for ever: new vulnerabilities are found in old packages. If a scan of **the latest
release** reports a fixable one, that is worth [telling the project](../../SECURITY.md) if it is CRITICAL; the fix is a new release.

## Hearing about fixes

- **Releases:** on the repository page choose **Watch -> Custom -> Releases** to be told about each one. The release notes are the
  changelog; a security fix is called out there and in a published
  [security advisory](https://github.com/sam-bowman/federated-chat-app/security/advisories).
- **Only the latest release gets fixes**, so following them means upgrading: see [Upgrading and backups](upgrading-and-backups.md) (back up
  first; a migration cannot be undone).
- **Docker Compose:** pin `IMAGE_TAG` to a version rather than `latest`, so you choose when an upgrade happens, and re-pull when you read a
  release note that matters. **Kubernetes:** `helm upgrade` to the new chart version.
- **Reporting something you find:** [SECURITY.md](../../SECURITY.md).
