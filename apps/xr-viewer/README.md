# GSPlatform WebXR Viewer

Standalone PlayCanvas Engine + WebXR viewer for immersive Gaussian scene viewing on VR headsets.

## Architecture

```text
XrRoot
  +-- PlayerRig (camera rig)
  |     `-- Camera
  +-- GaussianWorld (splats loaded here)
  +-- CollisionWorld (invisible collision proxy)
  +-- AnnotationRoot (3D annotations)
  `-- XRUiRoot (2D UI panels in VR)
```

## Supported Formats

- `.sog` — PlayCanvas SOG (loaded as container asset)
- `.ply` — Raw Gaussian splat PLY
- `.splat` — Raw splat format
- `streamed-sog` — LOD manifest (resolves to highest tier)

## Development

```bash
# Install dependencies
pnpm install

# Start dev server
pnpm dev

# Build for production
pnpm build

# Type check
pnpm typecheck
```

## Usage

### Load a scene via URL

Open `http://localhost:5180/?url=<sog-url>&format=sog&id=<sceneId>&title=<title>`

### Supported URL parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `url` | Asset URL for the Gaussian scene | (none) |
| `format` | Scene format: `sog`, `ply`, `splat`, `streamed-sog` | `sog` |
| `id` | Scene identifier | `unknown` |
| `title` | Human-readable title | `GSPlatform XR Scene` |

### WebXR

The viewer requires HTTPS for WebXR. For local development:

```bash
# Start dev server with HTTPS (requires self-signed certs)
pnpm dev
# Then access from VR device using the local IP
```

### VR Controls

1. Click **"Enter VR"** button to start VR session
2. Use VR controllers for navigation
3. Click **"Exit VR"** to end session

## Technical Details

- **Graphics**: WebGPU preferred, WebGL2 fallback
- **XR Support**: navigator.xr detection, VR session management
- **Scene Loading**: Same manifest format as desktop viewer
- **Collision**: Loads GLB collision proxy invisibly
- **Runtime Cleanup**: Proper resource disposal on session end

## Build Output

```
dist/
├── index.html
└── assets/
    └── index-[hash].js
```

The production build is a single-page application ready for deployment.

## Integration with GSPlatform

This viewer is part of the GSPlatform monorepo and uses the same scene manifest format as the desktop viewer (`apps/viewer`). It can load scenes from:

- Local development: `?url=/local-scenes/<sceneId>/manifest.json`
- Production API: `?url=<asset-url-from-api>`

The viewer shares no code with the desktop viewer to maintain independence (as required by Phase 13).
