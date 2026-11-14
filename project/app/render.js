import { renderHeader } from '../ui/header.js';
import { renderHome } from '../ui/home.js';
import { $ } from '../utils/helpers.js';

/** The home screen. Topics, the atlas and the quiz each take over #app themselves. */
export function render(){
  renderHeader();
  $('#app').innerHTML = renderHome();
}
