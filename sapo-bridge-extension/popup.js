const $=id=>document.getElementById(id);
chrome.storage.local.get(['workerUrl','bridgeToken'],v=>{$('workerUrl').value=v.workerUrl||'';$('bridgeToken').value=v.bridgeToken||'';});
$('save').addEventListener('click',async()=>{
 const workerUrl=$('workerUrl').value.trim().replace(/\/+$/,'');
 const bridgeToken=$('bridgeToken').value.trim();
 let origin;
 try{origin=new URL(workerUrl).origin;if(new URL(workerUrl).protocol!=='https:')throw new Error();}catch(_){$('status').textContent='Worker URL phải là HTTPS hợp lệ.';return;}
 if(bridgeToken.length<32){$('status').textContent='Bridge token cần tối thiểu 32 ký tự.';return;}
 const granted=await chrome.permissions.request({origins:[origin+'/*']});
 if(!granted){$('status').textContent='Chưa cấp quyền kết nối Worker.';return;}
 await chrome.storage.local.set({workerUrl,bridgeToken});
 $('status').textContent='Đã lưu. Hãy mở hoặc tải lại trang Sapo trên Edge.';
});