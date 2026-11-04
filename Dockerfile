FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY config ./config
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
VOLUME ["/app/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
