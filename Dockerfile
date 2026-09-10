FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install build dependencies for native modules if needed
RUN apk add --no-cache python3 make g++

# Copy package manifests
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application files
COPY . .

# Expose server port
EXPOSE 3000

# Default environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV ADMIN_USERNAME="Karan Singh"
ENV ADMIN_PASSWORD="Rajput2007"

# Start application
CMD ["npm", "start"]
