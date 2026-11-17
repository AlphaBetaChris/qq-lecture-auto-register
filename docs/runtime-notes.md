# NapCat runtime notes

The bundled NapCat runtime lives in `vendor/napcat/` and is kept separate
from the application code in `app/`.

- Do not place application features under `vendor/`.
- Runtime account data, caches, logs, and tokens are ignored by Git.
- Start the project from the repository root with `start.bat` or `npm run app`.
- NapCat remains responsible only for QQ login and OneBot event delivery.
