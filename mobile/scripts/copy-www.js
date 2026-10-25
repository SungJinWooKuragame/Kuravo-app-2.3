// copia ../app para ./www (o app é o MESMO código do Windows; nada é hospedado como site)
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, '..', '..', 'app'), dst = path.join(__dirname, '..', 'www');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log('www atualizado');
