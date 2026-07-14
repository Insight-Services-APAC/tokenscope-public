# fake-azure-monitor — Epic 6 stub for the @azure/monitor-query response shape.
#
# Container exists so `docker compose up` brings the full stack cleanly
# per docs/build/mvp-lite-epic.md. Non-root user per CWE-732 hygiene
# even though this is a dev-only stub.
FROM node:22-slim
WORKDIR /app
RUN groupadd --system app && useradd --system --gid app --create-home app \
 && chown -R app:app /app
COPY --chown=app:app package.json server.js ./
USER app
EXPOSE 8080
CMD ["node", "server.js"]
