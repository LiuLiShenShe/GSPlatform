# Third-Party Notices

This project includes the following third-party open-source components.

## SuperSplat

- **Project:** SuperSplat — 3D Gaussian Splat Editor
- **Upstream:** https://github.com/playcanvas/supersplat
- **Fork:** https://github.com/LiuLiShenShe/supersplat (baseline `12398f7f`, tag 3.0.0)
- **Location in repo:** `apps/viewer/`
- **License:** MIT (see `apps/viewer/LICENSE`)

```
Copyright (c) 2011-2026 PlayCanvas Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## PlayCanvas Engine (transitive dependency of apps/viewer)

- **Project:** PlayCanvas Engine
- **Source:** https://github.com/playcanvas/engine
- **License:** MIT (installed as `playcanvas` npm package)

## Additional npm dependencies

All other npm packages (React, Ant Design, Vite, Rollup, etc.) retain their
respective licenses as published on the npm registry. See each package's
`LICENSE` file under `node_modules` for details.

## Python dependencies (apps/api)

FastAPI, Uvicorn, Pydantic, SQLAlchemy, Alembic and dev tools (ruff, mypy,
pytest, httpx) are installed from PyPI and retain their respective licenses.
