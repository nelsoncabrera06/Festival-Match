FROM node:20-slim
WORKDIR /app

# Copiamos dependencias
COPY package*.json ./
RUN npm install --omit=dev

# Copiamos el resto del código
COPY . .

# IMPORTANTE: Asegurate de que el puerto sea el 8080
EXPOSE 8080

# Comando para arrancar
CMD ["npm", "start"]