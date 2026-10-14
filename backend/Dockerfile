FROM node:20-alpine AS frontend-builder

WORKDIR /frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/public ./public
COPY frontend/src ./src
COPY frontend/scripts ./scripts

ARG REACT_APP_API_URL
ENV REACT_APP_API_URL=$REACT_APP_API_URL
ENV GENERATE_SOURCEMAP=false

RUN npm run build && npm run check-build

FROM node:20-alpine AS app

WORKDIR /app

COPY backend/package*.json ./

RUN npm ci --omit=dev

COPY backend/src ./src
COPY --from=frontend-builder /frontend/build ./frontend-build

ENV NODE_ENV=production
ENV FRONTEND_BUILD_DIR=/app/frontend-build

EXPOSE 2001

CMD ["node", "src/index.js"]
