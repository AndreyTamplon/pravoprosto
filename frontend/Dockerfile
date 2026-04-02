# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Serve
FROM nginx:alpine

RUN apk add --no-cache openssl \
    && rm /etc/nginx/conf.d/default.conf \
    && mkdir -p /etc/letsencrypt/live/smartgoschool.ru \
    && openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
      -keyout /etc/letsencrypt/live/smartgoschool.ru/privkey.pem \
      -out /etc/letsencrypt/live/smartgoschool.ru/fullchain.pem \
      -subj "/CN=localhost"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /build/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
