import{hardExport as Gate}from"./app-initial-fixture.js";
function Composer(){let host=getHost(),hard=useFamily(Gate,host),busy=getBusy(),loading=getLoading();
function nestedHelper(){return true}let disabled=busy||loading||hard||nestedHelper;
return jsx(Input,{submitDisabled:disabled})}
