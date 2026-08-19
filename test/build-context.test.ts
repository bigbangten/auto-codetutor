import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCProject } from '../src/main/build-context.js';

test('.cproject에서 구성별 define, include 경로와 도구 체인을 읽는다', () => {
  const xml = `<?xml version="1.0"?>
  <cproject>
    <storageModule>
      <cconfiguration id="cfg.flash">
        <storageModule>
          <configuration id="cfg.flash.inner" name="Debug_FLASH">
            <folderInfo><toolChain name="Example GCC for Arm">
              <option valueType="definedSymbols"><listOptionValue builtIn="false" value="DEBUG"/><listOptionValue builtIn="false" value="BOARD_REV=3"/></option>
              <option valueType="includePath"><listOptionValue builtIn="false" value="&quot;\${workspace_loc:/sample}/include&quot;"/></option>
              <builder buildPath="\${workspace_loc:/sample}/Debug_FLASH"/>
            </toolChain></folderInfo>
          </configuration>
        </storageModule>
      </cconfiguration>
      <cconfiguration id="cfg.ram"><storageModule><configuration name="Debug_RAM"><folderInfo><toolChain name="Example GCC"><option valueType="definedSymbols"><listOptionValue value="RAM_BUILD"/></option></toolChain></folderInfo></configuration></storageModule></cconfiguration>
    </storageModule>
  </cproject>`;
  const configurations = parseCProject(xml);
  assert.equal(configurations.length, 2);
  assert.equal(configurations[0]?.name, 'Debug_FLASH');
  assert.deepEqual(configurations[0]?.defines, ['DEBUG', 'BOARD_REV=3']);
  assert.deepEqual(configurations[0]?.includePaths, ['"${workspace_loc:/sample}/include"']);
  assert.equal(configurations[0]?.toolchain, 'Example GCC for Arm');
  assert.equal(configurations[0]?.buildPath, '${workspace_loc:/sample}/Debug_FLASH');
});
