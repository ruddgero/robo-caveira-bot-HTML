FROM node:20-alpine
ENV TZ=America/Sao_Paulo NODE_ENV=production
RUN apk add --no-cache git tzdata
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
