# Hotfix dependencias Render

Este hotfix añade dependencias que el servidor puede importar en algunas variantes del proyecto:

- morgan
- express-rate-limit

Comandos equivalentes:

```bash
npm install morgan express-rate-limit --save
git add package.json package-lock.json
git commit -m "fix: add missing server dependencies"
```

En Render mantener:

```txt
Build Command: npm install
Start Command: npm start
```
