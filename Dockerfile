FROM node:20-alpine
WORKDIR /app

# install deps first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev

# copy the rest of the app
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
