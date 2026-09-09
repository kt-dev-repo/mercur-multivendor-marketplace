# Overlays

Fixes to **upstream-tracked files** that this repository deliberately does not
commit.

## Why

`main` is a byte-identical mirror of `mercurjs/mercur`. Nothing upstream owns is
ever modified in a commit, so `git diff upstream/main` shows only added files and
`git merge upstream/main` can never conflict — upstream releases can be pulled in
forever at zero cost.

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

## Adding an overlay

1. Edit the upstream file in a checkout and verify the change works.
2. `git diff <the file> > deploy/overlays/00N-short-name.patch`
3. `git checkout -- <the file>` to restore pristine.
4. `./deploy/overlays/apply.sh --check` — the new patch should read `pending`.
5. Commit only the `.patch` file.

## Retiring one

When upstream fixes the same thing, `apply.sh` reports `conflict` (or the patch
becomes a no-op). Delete the `.patch` file.
