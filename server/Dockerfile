# Build from the repository root:  docker build -f server/Dockerfile -t synx-server .
FROM node:22-alpine AS build
WORKDIR /repo
COPY app/src/shared ./app/src/shared
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --ignore-scripts
COPY server ./server
RUN cd server && npm run build

FROM node:22-alpine
WORKDIR /srv
ENV NODE_ENV=production PORT=8787
COPY --from=build /repo/server/dist/server.js ./server.js
COPY --from=build /repo/server/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts ws@8 && npm cache clean --force
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "server.js"]
