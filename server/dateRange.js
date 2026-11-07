'use strict';

// Parser de fechas del catalogo.
//
// Por que existe: `festivals.dates` es texto libre escrito a mano
// ("3-5 Junio 2027", "2-4 & 9-11 Octubre 2026"). Para saber si una edicion ya
// termino hace falta una fecha real, no un string. `starts_on`/`ends_on` son
// DERIVADOS de este texto (una sola fuente de verdad, igual que `region` se
// deriva de `country`), asi que este archivo tiene que ser el unico lugar donde
// se interpreta el formato.
//
// Devuelve strings ISO ('YYYY-MM-DD') y no objetos Date a proposito: un Date
// se serializa con zona horaria y escribirlo en una columna DATE puede correrse
// un dia segun el TZ del proceso. El string no tiene esa ambiguedad, y ademas
// se ordena lexicograficamente igual que una fecha.
//
// Contrato: { startsOn, endsOn } o { startsOn: null, endsOn: null }. Nunca una
// fecha inventada: si el texto no se entiende, se devuelven ambos null y el
// rollover lo saltea.

const MESES = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  // "Setiembre" es la variante sin p, bastante comun en el Cono Sur. La agrego
  // porque el parser tambien va a leer texto que escriba el extractor (fase 3),
  // no solo el catalogo actual.
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
};

// Guion comun, en dash y em dash. El catalogo usa '-', pero los sitios oficiales
// mezclan los tres y no cuesta nada aceptarlos.
const GUION = '[-\\u2013\\u2014]';

function sinFecha() {
  return { startsOn: null, endsOn: null };
}

function normalizar(texto) {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // saca tildes: "Miércoles" -> "miercoles"
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Valida contra el calendario real: 29/02 solo existe en bisiesto, 31/04 no
// existe. Sin esto, un typo del catalogo se convertiria en una fecha que
// Postgres rechaza a mitad de la migracion.
function esValida(anio, mes, dia) {
  if (!Number.isInteger(anio) || !Number.isInteger(mes) || !Number.isInteger(dia)) return false;
  if (anio < 1900 || anio > 2200) return false;
  if (mes < 0 || mes > 11 || dia < 1 || dia > 31) return false;

  const fecha = new Date(Date.UTC(anio, mes, dia));
  return fecha.getUTCFullYear() === anio
    && fecha.getUTCMonth() === mes
    && fecha.getUTCDate() === dia;
}

function aIso(anio, mes, dia) {
  const mm = String(mes + 1).padStart(2, '0');
  const dd = String(dia).padStart(2, '0');
  return `${anio}-${mm}-${dd}`;
}

function construir(anioInicio, mesInicio, diaInicio, anioFin, mesFin, diaFin) {
  if (!esValida(anioInicio, mesInicio, diaInicio)) return sinFecha();
  if (!esValida(anioFin, mesFin, diaFin)) return sinFecha();

  const startsOn = aIso(anioInicio, mesInicio, diaInicio);
  const endsOn = aIso(anioFin, mesFin, diaFin);
  if (startsOn > endsOn) return sinFecha();

  return { startsOn, endsOn };
}

// "2-4 & 9-11 Octubre 2026" / "17-19 & 24-26 Julio 2026": dos fines de semana
// del mismo mes. Para el rollover alcanza con el primer dia del primero y el
// ultimo del ultimo: si el festival termino el 11, termino el 11.
function parseDosTramos(texto) {
  const mesAnio = texto.match(/([a-z]+)\s+(\d{4})\s*$/);
  if (!mesAnio) return sinFecha();

  const mes = MESES[mesAnio[1]];
  const anio = Number(mesAnio[2]);
  if (mes === undefined) return sinFecha();

  const dias = [];
  for (const parte of texto.split('&')) {
    const rango = parte.match(new RegExp(`(\\d{1,2})\\s*${GUION}\\s*(\\d{1,2})`));
    if (rango) {
      dias.push(Number(rango[1]), Number(rango[2]));
      continue;
    }
    // Un tramo suelto ("5 & 12 Octubre 2026"). El lookahead evita que "2026"
    // se lea como un dia.
    const diaSuelto = parte.match(/(?:^|\s)(\d{1,2})(?=\s|$)/);
    if (diaSuelto) dias.push(Number(diaSuelto[1]));
  }

  if (dias.length === 0) return sinFecha();

  // min/max en vez de "primero y ultimo del array": si los tramos vinieran
  // desordenados, igual sale un rango coherente.
  const primero = Math.min(...dias);
  const ultimo = Math.max(...dias);
  return construir(anio, mes, primero, anio, mes, ultimo);
}

function parseDateRange(dates) {
  if (typeof dates !== 'string') return sinFecha();

  const texto = normalizar(dates);
  if (!texto) return sinFecha();

  if (texto.includes('&')) return parseDosTramos(texto);

  // Rango entre meses: "26 Junio - 3 Julio 2027". Va antes que el rango simple
  // porque la regex de rango simple no exige mes entre los dos numeros y
  // "junio" quedaria como dia unico.
  const entreMeses = texto.match(
    new RegExp(`(\\d{1,2})\\s+([a-z]+)\\s*${GUION}\\s*(\\d{1,2})\\s+([a-z]+)\\s+(\\d{4})`)
  );
  if (entreMeses) {
    const [, diaInicio, nombreInicio, diaFin, nombreFin, anio] = entreMeses;
    const mesInicio = MESES[nombreInicio];
    const mesFin = MESES[nombreFin];
    if (mesInicio === undefined || mesFin === undefined) return sinFecha();

    // Cruce de año: solo Diciembre -> Enero. Cualquier otro "fin antes que
    // inicio" es un typo, no un festival de doce meses.
    let anioInicio = Number(anio);
    if (mesInicio > mesFin) {
      if (!(mesInicio === 11 && mesFin === 0)) return sinFecha();
      anioInicio -= 1;
    }

    return construir(
      anioInicio, mesInicio, Number(diaInicio),
      Number(anio), mesFin, Number(diaFin)
    );
  }

  // Rango en el mismo mes: "3-5 Junio 2027".
  const mismoMes = texto.match(
    new RegExp(`(\\d{1,2})\\s*${GUION}\\s*(\\d{1,2})\\s+([a-z]+)\\s+(\\d{4})`)
  );
  if (mismoMes) {
    const [, diaInicio, diaFin, nombreMes, anio] = mismoMes;
    const mes = MESES[nombreMes];
    if (mes === undefined) return sinFecha();
    return construir(Number(anio), mes, Number(diaInicio), Number(anio), mes, Number(diaFin));
  }

  // Un solo dia: "24 Octubre 2026".
  const unDia = texto.match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
  if (unDia) {
    const [, dia, nombreMes, anio] = unDia;
    const mes = MESES[nombreMes];
    if (mes === undefined) return sinFecha();
    return construir(Number(anio), mes, Number(dia), Number(anio), mes, Number(dia));
  }

  // Solo mes y año: "Mayo 2026". El frontend ya lo interpreta como mes
  // completo, asi que aca hago lo mismo. Exijo que sea el string entero para no
  // inventar fechas de un texto que solo menciona un mes al pasar.
  const soloMes = texto.match(/^([a-z]+)\s+(\d{4})$/);
  if (soloMes) {
    const mes = MESES[soloMes[1]];
    const anio = Number(soloMes[2]);
    if (mes === undefined) return sinFecha();
    const ultimoDia = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
    return construir(anio, mes, 1, anio, mes, ultimoDia);
  }

  // "2027 (fecha por anunciar)", "2027 (confirmado)", "TBA", etc: hay año pero
  // no hay fecha. Se devuelve null y el rollover lo saltea.
  return sinFecha();
}

module.exports = { parseDateRange };
