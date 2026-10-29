/* Keep notices and controls in document flow so translated text cannot overlap buttons. */
(function () {
  const world = document.querySelector('.city-world');
  const stack = document.createElement('div');
  stack.className = 'city-hud-stack';
  for (const id of ['gardenWayfinder', 'cityToast', 'carInvitation', 'carMessages', 'cityQuickActions', 'cityActivityHud']) {
    const element = document.getElementById(id);
    if (element) stack.append(element);
  }
  world.append(stack);
  const context = document.createElement('div');
  context.className = 'city-context-actions';
  context.append(document.getElementById('vehicleHud'), document.getElementById('gardenControls'));
  world.append(context);
  const row = document.querySelector('.garden-actions');
  const choices = document.querySelector('.garden-dance-choices');
  row.append(choices, document.getElementById('gardenExpand'));
  document.getElementById('gardenExpand').setAttribute('aria-label', 'ცეკვისა და ბაღის პარამეტრები');
  document.getElementById('carMore').textContent = 'ადგილები · რადიო';
})();
