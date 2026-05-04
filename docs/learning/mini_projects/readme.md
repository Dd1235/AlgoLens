Some mini projects to review js and nodejs syntax

```
mkdir 1 && cd 1
npm init -y
touch server.js
node server.js
```

`package.json`

```
"scripts" : {
    "start": "node server.js"
    "dev":"nodemon index.js"
}
```

run `npm start`

`npm install express` - runtime dependency
`npm install --save-dev nodemon` - dev dependency
