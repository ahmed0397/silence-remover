FROM node:20-slim

# Install system dependencies including FFmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Environment variables
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
