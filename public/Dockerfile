FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# corre en 5173 (asi lo defini en Terraform)
EXPOSE 5173

# Comando para iniciar la aplicacion en modo desarrollo
# CMD ["npm", "run", "dev", "--", "--host"]

# Para produccion, descomenta la siguiente linea y comenta la anterior
CMD ["npm", "start"]
