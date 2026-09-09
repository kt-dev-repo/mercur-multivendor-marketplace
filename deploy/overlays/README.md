# Overlays

Fixes to **upstream-tracked files** that this repository deliberately does not
commit.

## Why

`main` is a byte-identical mirror of `mercurjs/mercur`. Nothing upstream owns is
ever modified in a commit, so the diff against our upstream base shows only added
files and `git merge upstream/main` can never conflict — upstream releases can be
pulled in forever at zero cost.

```bash
# Verify the invariant. Compare against the upstream commit we are BASED on,
# not upstream/main — once upstream advances, its tip differs from our base and
# a plain `git diff upstream/main` reports upstream's own changes as if they
# were ours.
git diff --diff-filter=MDR --name-only "$(git merge-base HEAD upstream/main)"
# empty output = no upstream-tracked file was modified
```

That guarantee would be lost the moment a fix edited an upstream file. So fixes
live here as patches and are applied **on a copy**: inside the container image at
build time, or temporarily in a local checkout while developing.

Mercur uses the same idea internally — `packages/core/src/patches/` patches
`@medusajs/core-flows` rather than forking it.

## Usage

```bash
./deploy/overlays/apply.sh            # apply every overlay
./deploy/overlays/apply.sh --check    # report status, change nothing
./deploy/overlays/apply.sh --revert   # restore the pristine upstream files
./deploy/overlays/apply.sh --only 001 # act on one overlay by prefix
```

Applying is idempotent. `git status` will show modified upstream files while
overlays are applied — that is expected; `--revert` returns the tree to pristine.
**Never commit an overlaid file.**

The three Dokploy images run `apply.sh` during their build, so deployments get
these fixes without the repository ever carrying them.

## States

| State | Meaning |
|---|---|
| `pending` | applies cleanly, not yet applied |
| `applied` | already in the tree |
| `skipped` | none of the patch's target files exist here — images copy only part of the tree, so the docs overlay is skipped in them |
| `conflict` | targets exist but the patch will not apply — **upstream changed underneath it**; regenerate the patch, do not force it |

A conflict fails the script (and therefore the image build) on purpose. A
half-applied overlay is worse than none.

## The overlays

### `001-storefront-not-found-status.patch`

Unknown product, seller and collection handles returned **HTTP 200** instead of
404. `ProductDetailsPage` did `if (!prod) return null`, so the page rendered
chrome with no content and no `<title>`; the seller page did the same; the
collection page rendered the not-found component but left the status at 200, as
did the suspended-seller branch. These are soft 404s — search engines index the
empty pages. Uses `notFound()` from `next/navigation` in all four places, which
is what `categories/[category]` already did.

Verified in the production image: unknown product/seller/collection → 404, while
`/de`, an existing product and an existing seller still return 200.

### `002-jest-swc-transform-resolution.patch`

`bun run test:unit` failed before running a single test with
`Module @swc/jest in the transform option was not found`. The unit run sets
`rootDir` to the repo root to reach specs in the workspace packages, and Jest
resolves transforms relative to `rootDir` — but `@swc/jest` is a devDependency of
`integration-tests` and is not hoisted there. Resolves both transforms with
`require.resolve`, from the config file rather than from `rootDir`.

Verified: unit run 13 passed / 3 suites; the HTTP suites share the block and are
unaffected.

### `003-dashboard-ports-docs.patch`

`CLAUDE.md` and `docs/ARCHITECTURE.md` documented admin on 7000 and vendor on
7001. Those are the `preview` ports; the `dev` scripts bind **7001** and **7002**
— the values that must appear in `ADMIN_CORS` / `VENDOR_CORS`. Also replaces the
fixed worktree URLs with `./scripts/dev-worktree.sh <name> ports`, since that
script assigns a free port per worktree.

Docs only. Skipped inside images, which do not copy `docs/` or `CLAUDE.md`.

### `004-s3-file-provider-switch.patch`

`apps/api/medusa-config.ts` hardcoded Medusa's **local** file provider. That
writes to the container filesystem, bakes its origin into every stored file URL,
cannot be shared across API replicas, and breaks when the public origin changes.

Makes the provider a switch driven by env: **`S3_BUCKET` set → S3, otherwise
local**, so local development is unchanged and production opts in without a code
change. Resolve string is `@medusajs/medusa/file-s3` — note `@medusajs/file-s3`
is NOT resolvable from `apps/api` under bun's isolated layout, only the path
re-exported through `@medusajs/medusa`.

Handles the awkward parts of real S3-compatible services:

| Variable | Why it exists |
|---|---|
| `S3_ENDPOINT` | required by everything that is not real AWS |
| `S3_FORCE_PATH_STYLE` | MinIO and other path-style services |
| `S3_ACL=false` | buckets that reject ACL headers — AWS Object Ownership `BucketOwnerEnforced` (default since 2023) and Cloudflare R2 |
| `S3_AUTHENTICATION_METHOD=s3-iam-role` | instance roles / IRSA, with both keys omitted |
| `S3_ADDITIONAL_CLIENT_CONFIG` | raw JSON escape hatch into the S3 client |

Verified against MinIO: with `S3_BUCKET` set the API booted clean, `/admin/uploads`
returned an `S3_FILE_URL`-based URL, the object appeared in the bucket, and
fetching that URL returned the exact bytes. Removing `S3_BUCKET` reverted to
`http://localhost:9000/static/...` and local uploads still served correctly — the
switch works in both directions with no code change.

## Adding an overlay

1. Edit the upstream file in a checkout and verify the change works.
2. `git diff <the file> > deploy/overlays/00N-short-name.patch`
3. `git checkout -- <the file>` to restore pristine.
4. `./deploy/overlays/apply.sh --check` — the new patch should read `pending`.
5. Commit only the `.patch` file.

## Retiring one

When upstream fixes the same thing, `apply.sh` reports `conflict` (or the patch
becomes a no-op). Delete the `.patch` file.
