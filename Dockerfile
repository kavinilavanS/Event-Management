FROM node:22-alpine

WORKDIR /app

# Copy dependency specifications
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Expose default HTTP port
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# Start server with background hold cleanup worker
CMD ["node", "server.js"]
