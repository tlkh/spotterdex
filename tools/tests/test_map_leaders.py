import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which('node'), 'Node.js is required')
class MapLeaderTests(unittest.TestCase):
    def test_crossings_are_rejected(self):
        result = subprocess.run(['node', '-e', """
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const c = vm.createContext({});
vm.runInContext(fs.readFileSync('map-page.js', 'utf8'), c);
const layout = {point:{x:0,y:0}};
const bounds = {left:100,right:140,top:-10,bottom:10};
assert.equal(c.mapLeaderIsClear(layout,bounds,[],[{x:50,y:0}],12,[]),false);
assert.equal(c.mapLeaderIsClear(layout,bounds,[],[{x:50,y:30}],12,[]),true);
const other = {point:{x:50,y:-50},bounds:{left:40,right:60,top:40,bottom:60}};
assert.equal(c.mapLeaderIsClear(layout,bounds,[other],[],12,[]),false);
assert.equal(c.mapLeaderIsClear(layout,bounds,[],[],12,[{left:40,right:60,top:-5,bottom:5}]),false);
"""], cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_mobile_callouts_bound_and_declutter_pin_workload(self):
        result = subprocess.run(['node', '-e', """
const fs = require('fs'), vm = require('vm'), assert = require('assert');
let mobile = true;
let padCalls = 0;
const pins = [
  {id:'near-a', lat:0, lon:0, name:'Near A'},
  {id:'near-b', lat:0.1, lon:0.1, name:'Near B'},
  {id:'selected', lat:10, lon:10, name:'Selected'}
];
const bounds = {
  pad(value) {
    assert.equal(value, 0.22);
    padCalls += 1;
    return this;
  },
  contains([lat, lon]) {
    return lat >= -1 && lat <= 1 && lon >= -1 && lon <= 1;
  }
};
const context = vm.createContext({
  state: {
    map: {
      getBounds: () => bounds,
      getZoom: () => 3,
      latLngToContainerPoint: ([lat, lon]) => (
        lat === 10 ? {x:200, y:200} : lat === 0.1 ? {x:105, y:105} : {x:100, y:100}
      )
    },
    enabledPins: pins,
    mapDiscoveryPinIds: new Set(pins.map(pin => pin.id)),
    selectedPinId: 'selected',
    pinById: new Map(pins.map(pin => [pin.id, pin]))
  },
  isMobileMapLayout: () => mobile,
  photosForPin: pin => [{sortTime: pin.id === 'near-b' ? 30 : 20}]
});
vm.runInContext(fs.readFileSync('map-page.js', 'utf8'), context);

assert.deepEqual(context.mapPinsForCallouts().map(pin => pin.id), ['selected', 'near-b']);
assert.equal(padCalls, 1);

mobile = false;
assert.deepEqual(context.mapPinsForCallouts().map(pin => pin.id), ['near-b', 'near-a']);
assert.equal(padCalls, 1);
"""], cwd=Path(__file__).resolve().parents[2], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
