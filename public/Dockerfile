FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# corre en 5173 (asi lo defini en Terraform)
EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host"]
