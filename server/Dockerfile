FROM node:18-alpine

# Crear directorio de trabajo
WORKDIR /app

# Copiar dependencias primero (cache)
COPY package*.json ./
RUN npm install

# Copiar el resto del código
COPY . .

# Puerto del backend 3002 sacado del .env
EXPOSE 3002 

# Comando de arranque
CMD ["npm", "start"]
