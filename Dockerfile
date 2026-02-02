# 1. Etapa de Construcción (Build)
FROM node:20-slim AS builder

WORKDIR /app

# Copiamos archivos de dependencias
COPY package*.json ./

# Instalamos dependencias
RUN npm install

# Copiamos el resto del código y buildeamos (si es React/Next)
COPY . .
# Si es solo backend, podés comentar la línea de abajo
RUN npm run build 

# 2. Etapa de Ejecución (Run) - Para que la imagen sea minúscula
FROM node:20-slim

WORKDIR /app

# Solo copiamos lo necesario del builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist 
# (Cambiá ./dist por ./build o lo que use tu framework)

# Google Cloud Run usa el puerto 8080 por defecto
EXPOSE 8080

# Comando para arrancar la app
CMD ["npm", "start"]