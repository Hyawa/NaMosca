import './style.css'
import { App } from './screens/app.ts'

const root = document.getElementById('app')
if (root === null) {
  throw new Error('Elemento #app não encontrado')
}

const app = new App(root)
void app.boot()
