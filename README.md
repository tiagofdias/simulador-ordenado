# Simulador de Domiciliação de Ordenado

##  Funcionalidades

- Cálculo personalizado com base no teu ordenado, idade e saldo
- Comparação com Certificados de Aforro
- Partilha de link com os teus dados
- **Atualização automática diária** via GitHub Actions

## 🔄 Atualização Automática

Os dados dos bancos e da taxa dos Certificados de Aforro são atualizados automaticamente todos os dias às 9:00 (hora de Portugal) via [GitHub Actions](.github/workflows/update-data.yml).

O script de atualização:
1. Consulta os sites oficiais de cada banco
2. Verifica se as campanhas ainda estão ativas
3. Consulta a taxa dos Certificados de Aforro no IGCP
4. Se houver alterações, atualiza o ficheiro `data/banks.json` e faz commit automático
5. O GitHub Pages republica automaticamente

### Executar manualmente

Podes também executar a atualização manualmente:

```bash
# Instalar dependências
npm install

# Executar atualização
npm run update
```

Ou diretamente no GitHub: **Actions** → **🔄 Atualizar dados dos bancos** → **Run workflow**

## 🚀 Deploy

O site está publicado no GitHub Pages e é atualizado automaticamente em cada push para `main`.

### Setup inicial

1. Cria um repositório no GitHub
2. Faz push deste projeto
3. Vai a **Settings** → **Pages** → **Source**: seleciona **GitHub Actions**
4. O site será publicado automaticamente

## 📁 Estrutura

```
├── index.html                    # Interface principal
├── data/
│   └── banks.json                # Dados dos bancos (atualizado automaticamente)
├── updater/
│   ├── update.js                 # Script de atualização automática
│   ├── config.json               # Configuração das fontes
│   └── logs/                     # Logs de execução
├── .github/
│   └── workflows/
│       ├── update-data.yml       # Atualização diária
│       └── deploy-pages.yml      # Deploy GitHub Pages
├── package.json
└── README.md
```

## 📝 Editar dados manualmente

Se precisares de atualizar os dados manualmente (ex: nova campanha), edita o ficheiro [`data/banks.json`](data/banks.json) e faz commit. O site será atualizado automaticamente.

## ⚠️ Aviso Legal

Este simulador não constitui aconselhamento financeiro. Os valores são estimativas baseadas nas condições públicas de cada banco. Confirma sempre as condições oficiais antes de aderires.
