//be careful with plurals - all the singular words are dealing with one object, and the plurals are dealing with multiple
//database types:
//	item
//	staged
//	history
//  settings
//allowable push changes:
//	lock
//	flag
//	comment

console.log('server running');

//new media
/*
if(req.body.newMedia) {
	userMediaUID=generateUID();
	console.log('media url: '+req.body.mediaUrl);
	delete req.body.newMedia;
	if(!req.body.media) { req.body.media = []; }
	req.body.media.push({image:'media/images/'+userMediaUID+'/image.jpg',thumb:'media/images/'+userMediaUID+'/thumb.jpg',});
}
*/


//CONFIG -------------------------------------------------------------------------------------
//database
var mongojs = require('mongojs');
var db = mongojs('mongodb://localhost:27017/itemdb', ['itemdb']);
//app engine
var express = require('express'),
    app = express();
//app configuration
app.configure(function(){
    app.use(app.router);
    app.use(express.static(__dirname + '/www'));
    app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
});

var http = require('http').Server(app);
var io = require('socket.io')(http);

//email auth
var nodemailer = require('nodemailer');
var smtpTransport = require('nodemailer-smtp-transport');
smtpTrans = nodemailer.createTransport(smtpTransport({
	service:'gmail',
 	auth: {
      	user: "colabrobot@gmail.com",
      	pass: "r0b0tp4r4d3" 
  	}
}));
//the following are used for images (but can also be used for a shit-ton of other things)
var fs = require('fs');
var request = require('request');
var q = require('q');
var url = require('url');
var _ = require('underscore');
var moment = require('moment');
var jquery = require('jquery');
//image manipulation (for thumbnails)
var gm = require('gm').subClass({ imageMagick: true });
//make directory for item images:
if (!fs.existsSync('/vagrant/www/media/images')) {
	fs.mkdir('/vagrant/www/media/images/');
}
//default item image:
var defaultImage = 'images/default.jpg';

var dbInfo = {
    formElements:['text', 'textarea', 'url'],
    types:[
      {
        name:'tool',
        color:{r:'76',g:'164',b:'84'},
        formFields:[
          {name:'need', type:'radio', options:['have','want'], default:'have'},
          {name:'description',type:'textarea'}, 
          {name:'location',type:'text'},
          {name:'image search', type:'image-search'},
          {name:'imageURL', type:'url'}
        ]
      },
      {
        name:'resource',
        color:{r:'68',g:'114',b:'185'},
        formFields:[
          {name:'need', type:'radio', options:['have','want'], default:'have'},
          {name:'description',type:'textarea'}, 
          {name:'location',type:'text'},
          {name:'image search', type:'image-search'},
          {name:'imageURL', type:'url'}
        ]
      },
      {
        name:'project',
        color:{r:'225',g:'135',b:'40'},
        formFields:[
          {name:'description',type:'textarea'},
		  {name:'image search', type:'image-search'},
          {name:'imageURL', type:'url'}
        ]
      }, 
      {
        name:'book',
        color:{r:'190',g:'76',b:'57'},
        formFields:[
          {name:'need', type:'radio', options:['have','want'], default:'have'},
          {name:'description',type:'textarea'},
          {name:'image search', type:'image-search'},
          {name:'imageURL', type:'url'}
        ]
      },
      {
        name:'event',
        color:{r:'147',g:'81',b:'166'},
        formFields:[
          {name:'title', type:'text'},
          {name:'description',type:'textarea'},
          {name:'start', type:'text'},
          {name:'end', type:'text'}
        ]
      },
      {
      	name:'deleted',
      	color:{r:'225',g:'20',b:'20'}
      }
    ]
};


//API ---------------------------------------------------------------------------------------
//ITEMS  --------------------------------
app.get('/api/getDatabase', function (req, res) {
	db.itemdb.find(function (err, docs) {
		if(err){ console.log('(error getting database) '+err);}else { res.send(docs); }
	});
});//end GET database

app.post('/api/getItems', express.json(), function (req, res) {
	var query = {};
	if (req.body.type) { query['type'] = req.body.type; }
	else { query = { $or:_(dbInfo.types).map(function(item){ return {'type':item.name}; }) }; }
	db.itemdb.find(query,function (err, docs) {
		if(err){ console.log('(error getting items) '+err); }else{ res.send(docs); }
	});
});//end GET items

app.post('/api/getItemHistory', express.json(), function (req, res) {
	db.itemdb.find({type:'history', forUID:req.body.uid},function (err, docs) {
		if(err){ console.log('(error getting item history) '+err); }else{ 
			res.send(docs); 
		}
	});
});//end GET item history

app.post('/api/getItem', express.json(), function (req, res) {
	db.itemdb.findOne(req.body, function (err, doc) {
		if(err){ console.log('(error getting item) '+err); }else{ res.send(doc); }
	});
});//end 'GET' (single) item - send the uid and retrieve item (untested - send multiple uid's?)

app.post('/api/saveItem', express.json(), function (req, res) {
	var syncItemPromise;
	if (req.body.uid) {
		db.itemdb.find({uid:req.body.uid}, function (err, check) {
			if (!check.length||check[0].uid!==req.body.uid) {
				return res.send(500);
			}
			//it is there
			syncItemPromise=updateItem(req.body, check[0]);
			q.when(syncItemPromise).then(function(){
				res.send(200);
			}); 
		});
	} else {
		//brand new item!!!
		syncItemPromise=newItem(req.body);
		q.when(syncItemPromise).then(function(){
			res.send(200);
		}); 
		
	}
});//end SAVE single item

app.post('/api/stageItemChanges', express.json(), function (req, res) {
	var newItem=req.body;
	if (newItem.uid) {
		db.itemdb.find({uid:newItem.uid}, function (err, check) {
			if (!check.length||check[0].uid!==newItem.uid) {
				return res.send(500);
			}
			//it is there
			var originalItem=check[0];
			var proposer = newItem.proposedBy;
			if(proposer){
				newKey=generateKey();
				delete newItem.proposedBy;

				var stagedChanges=[];

				//save image if one
				if (originalItem.imageURL!==newItem.imageURL){
					console.log('saving new item image')
					var mediaUID = generateUID();
					saveImage(newItem.imageURL,mediaUID);
					newItem.image = 'media/images/'+mediaUID+'/image.jpg';
					newItem.thumb = 'media/images/'+mediaUID+'/thumb.jpg';
				}
				
				var changeNumber = 0;
				for (key in newItem){
					if (JSON.stringify(newItem[key])!==JSON.stringify(originalItem[key])){
						//console.log('difference in '+key+' is '+JSON.stringify(scope.changed[key])+' -- original:'+JSON.stringify(scope.original[key]));
						if((key!=='lockChangedBy')&&(key!=='lockChangedAt')&&(key!=='edited')&&(key!=='editedBy')&&(key!=='image')&&(key!=='lock')&&(key!=='imageURL')&&(key!=='owners')) {
							var aChange = {};
							aChange['what']=key;
							aChange['value']=newItem[key];
							aChange['decision']='';
							if (key==='thumb'){
								aChange['image']=newItem['image'];
								aChange['imageURL']=newItem['imageURL'];
							}
							stagedChanges[changeNumber]=aChange;
							changeNumber++;
						}
					}
				}


				if (stagedChanges.length!==0){
					//insert change for every owner to approve
					_.map(originalItem.owners, function(owner) {  
						db.itemdb.insert({type:'staged', forUID:newItem.uid, key:newKey, proposed:moment().format(), proposedBy:proposer, forOwner:owner, changes:stagedChanges}, function (err, doc) {
							if(err){ 
								console.log('(error staging item changes) '+err); 
							}else{ 
								originalItem.proposedChanges=true;
								db.itemdb.update({uid: newItem.uid}, {$set:{proposedChanges:true}}, function (err, doc2) {
									if(err){ 
										console.log('(error setting staged changes flag on item) '+err); 
									} else {
										//success
										res.send(200);
										io.emit('proposedChange',newItem.uid);
									}
								});
							}
						});
					});//end map
					
				} else {
					//no mods
				}

			} else {
				//fail - no proposedBy
			}
		});
	} else { 
		//no item found matching that uid
	}
});//end 'STAGE' changes

app.post('/api/decision', express.json(), function (req, res){
	var syncItemPromise;
	db.itemdb.find({key:req.body.key, forOwner:req.body.email}, function (err, check) {
		if (!check.length||check[0].key!==req.body.key) {
			return res.send(500);
		}
		//it is there
		syncItemPromise=changeDecision(check[0], req.body.email, req.body.field, req.body.decision);
		q.when(syncItemPromise).then(function(){

			//check if all decisions are made
			db.itemdb.find({key:req.body.key}, function (err, check2) {
				var done = true;
				var allDec = check2[0].changes;
				for (k in allDec) {
					if (allDec[k].decision==='') { done=false; }
				}

				if (done) {
					console.log('all changes are complete');
					req.body.item.proposedChanges=false;
				} else {
					console.log('more changes...');
				}
				//update item
				db.itemdb.find({uid:req.body.item.uid}, function (err, check1) {
					if (!check1.length||check1[0].uid!==req.body.item.uid) {
						return res.send(500);
					}
					//it is there
					syncItemPromise=updateItem(req.body.item, check1[0], true);
					q.when(syncItemPromise).then(function(){
						res.send(200);
					});
				});
			}); 	
		}); 
	});
});


app.post('/api/deleteItem', express.json(), function (req, res){
	var syncItemPromise;
	req.body.oldType = req.body.type;
	req.body.type = 'deleted';
	db.itemdb.find({uid:req.body.uid}, function (err, check) {
		if (!check.length||check[0].uid!==req.body.uid) {
			return res.send(500);
		}
		//it is there
		syncItemPromise=updateItem(req.body, check[0]);
		q.when(syncItemPromise).then(function(){
			res.send(200);
		}); 
	});

});//end DELETE item

app.post('/api/requestLock', express.json(), function (req, res){
	var syncLockPromise;
	db.itemdb.findOne({uid:req.body.uid}, function (err, item){
		if(err||!item){ console.log('(error requesting lock on item) '+err); }
		else { 
			if (item.lock){
				//already has a lock
				console.log('we are here....')
				res.send(item);
			} else {
				//does not have lock yet
				syncLockPromise = changeLock(item,req.body.email, true);
				q.when(syncLockPromise).then(function(){
					res.send(item);
				});
				
			}
		}
	});
});//end request lock item

app.post('/api/removeLock', express.json(), function (req, res){
	var syncLockPromise;
	if (req.body.uid) {
		console.log('removing lock for item: '+req.body.uid)
		db.itemdb.findOne({uid:req.body.uid}, function (err, item){
			if(err||!item){ console.log('(error removing lock on item) '+err); }
			else { 
				syncLockPromise = changeLock(item,req.body.email, false);
				q.when(syncLockPromise).then(function(){
					res.send(item);
				});
			}
		});
	}
});//end remove lock item

app.post('/api/pickLock', express.json(), function (req, res){
	var syncLockPromise;
	console.log('breaking lock for item: '+req.body.uid)
	db.itemdb.findOne({uid:req.body.uid}, function (err, item){
		if(err||!item){ console.log('(error removing lock on item) '+err); }
		else { 
			if((item.owner)||(item.owner===req.body.email)||(item.lockChangedBy===req.body.email)){
				syncLockPromise = changeLock(item,req.body.email, false);
				q.when(syncLockPromise).then(function(){
					res.send(item);
				});
			} else { 
				//send the owner an email 
			}
		}
	});
});//end break lock item

//needs in post:  {uid:uidofitem, email:usermakingedit, value:1or-1or0}
app.post('/api/setPriority', express.json(), function (req, res){
	var currentPriority;
	db.itemdb.findOne({uid:req.body.uid},function (err, doc) {
		if(err){ console.log('(error finding item) '+err); }
		else { 
			if (doc.priority){
				//exists
				currentPriority=doc.priority;
			} else {
				currentPriority=[];
			}
			//find if user already added
			var userPriority = _.findWhere(currentPriority,{email:req.body.email});
			if (userPriority) {
		 		var index = currentPriority.indexOf(userPriority);
		 		var newPriority = currentPriority;
		 		newPriority[index] = {email:req.body.email, value:req.body.value};
		 	} else {
		 		//not added yet
		 		var newPriority=currentPriority;
		 		newPriority.push({email:req.body.email, value:req.body.value});
		 	}

		 	//add up all priorities:
		 	var totalPriority = _.reduce(newPriority, function(memo,element){ return memo + element.value; },0);

		 	doc.totalPriority = totalPriority;

		 	if (newPriority){
		 		doc.priority=newPriority;
			 	db.itemdb.update({uid:req.body.uid}, {$set:{priority:newPriority, totalPriority:totalPriority}}, function (err,doc2){
			 		if(err){ console.log('(error updating priority) '+err); }else{ 
			 			io.emit('priorityChange', doc);
			 			res.send(doc); 
			 		}
			 	});
			}
		}
	});
});

app.post('/api/addComment', express.json(), function (req, res) {
	
	db.itemdb.findOne({uid:req.body.uid}, function (err, item){
		if(err){ console.log('(error finding item) '+err); }
		else { 
			if(!item.comments) { item.comments = []; }
			var timeTime = moment().format();
			item.comments.push({words:req.body.comment, by:req.body.email, time:timeTime});

			var pushValue = {};
			pushValue.$set = {};
			pushValue.$set['comments'] = item.comments; 
			db.itemdb.update({uid: req.body.uid}, pushValue, function (err, doc) {
				if(err){ console.log('(error updating comments) '+err); }else{ 
					io.emit('comment', item);
					res.send(doc); 
				}
			});
		}
	});

});//end add comment



//ITEMS --------------------------------
function updateItem(newItem, oldItem, stage){
	//returns a promise
	var saveItemPromise = q.defer();
	var syncImagePromise;

	if (oldItem.imageURL!==newItem.imageURL){
		console.log('saving new item image')
		var mediaUID = generateUID();
		syncImagePromise = saveImage(newItem.imageURL,mediaUID);
		newItem.image = 'media/images/'+mediaUID+'/image.jpg';
		newItem.thumb = 'media/images/'+mediaUID+'/thumb.jpg';
	}


	var historyItem;
	historyItem=oldItem;
	historyItem.uid=generateUID();
	historyItem.historical=true;
	historyItem.proposedChanges=false;
	//update and store history
	db.itemdb.insert({type:'history', forUID:newItem.uid, historyItem:historyItem }, function (err, doc) {});

	newItem.edited=moment().format();
	if (!stage) { newItem.lock=false; }
	delete newItem._id;
	//check to see if new image was sent
	
	db.itemdb.update({uid: newItem.uid}, newItem, function (err, doc) {
		if(err){ 
			console.log('(error updating item) '+err); 
			saveItemPromise.reject(); 
		}else{ 
			q.when(syncImagePromise).then(function(){
				saveItemPromise.resolve();
				console.log('sending new update io.emit');
				io.emit('update', newItem);
			}); 
		}
	});


	return saveItemPromise.promise;
}

function newItem(newItem){
	//returns a promise
	var saveItemPromise = q.defer();
	var syncImagePromise;
	newItem.uid=generateUID();
	newItem.totalPriority=0;
	newItem.created=moment().format();
	newItem.edited='never';
	//set owner as creator if not specified
	if (!newItem.owners) { newItem.owners =[]; newItem.owners.push(newItem.createdBy); }

	if (newItem.imageURL) {
		//image url provided
		var mediaUID = generateUID();
		syncImagePromise = saveImage(newItem.imageURL,mediaUID);
		newItem.image = 'media/images/'+mediaUID+'/image.jpg';
		newItem.thumb = 'media/images/'+mediaUID+'/thumb.jpg';
	}else{
		//no image, use default
		newItem.image = defaultImage;
		newItem.thumb = defaultImage;
	}
	db.itemdb.insert(newItem, function (err, doc) { 
		if(err){ 
			console.log('(error saving item) '+err);
			saveItemPromise.reject(); 
		}else{ 
			q.when(syncImagePromise).then(function(){
				saveItemPromise.resolve();
				console.log('item: ' + doc.uid);
			    io.emit('new', doc);
			}); 
		} 
	});

	return saveItemPromise.promise;
}

//IMAGES --------------------------------
//takes a where (url), a uid to use, and who (opt - used for user added)
function saveImage(where,theUID,who) {
	//returns a promise
	var saveImagePromise = q.defer();
	request.get({url: url.parse(where), encoding: 'binary'}, function (err, response, body) {
		console.log('trying to save image uid: '+theUID);
		var path = '/vagrant/www/media/images/'+theUID+'/';
		fs.mkdir(path, function(err){
			if (err) {
				console.log('error saving image: '+err); 
	    		saveImagePromise.reject();
			} else {
				fs.writeFile(path+"image.jpg", body, 'binary', function(err) {
			    	if(err) { 
			    		console.log('error saving image: '+err); 
			    		saveImagePromise.reject();
			    	}else{ 
			    		//save image thumbnail
			    		
			    		console.log("the image was saved!"); 
			    		gm(path+'image.jpg').resize('60','60').gravity('center').write(path+'thumb.jpg', function(err) {
			    			if(err) { 
			    				console.log('error saving thumb: '+err); 
			    				saveImagePromise.reject();
			    			}else{ 
			    				//successful image save chain:
			    				saveImagePromise.resolve();
			    				console.log("the image thumb was saved!"); 
			    			}
			    		});//end save image thumb
			    	}//end save image
		    	});
			}
		});
	});

	return saveImagePromise.promise;
}//end SAVE image

//LOCKS --------------------------------
function changeLock(item,who,value){
	var changeLockPromise = q.defer();
	var time = moment().format();
	item.lock=value;
	item.lockChangedBy=who;
	item.lockChangedAt=time;

	db.itemdb.update({uid: item.uid}, {$set:{lock:value, lockChangedBy:who, lockChangedAt:time}}, function (err, doc) {
		if(err){ 
			console.log('(error changing lock on item) '+err); 
			changeLockPromise.reject();
		} else {
			//success
			io.emit('lockChange',item);
			changeLockPromise.resolve();
		}
	});

	return changeLockPromise.promise;
}

function changeDecision(staged, who, what, value){
	var changeDecisionPromise = q.defer();
	var time = moment().format();

	_.find(staged.changes, function(change, i){
		if (change['what']===what){ staged.changes[i].decision=value; }
	});

	db.itemdb.update({key: staged.key}, {$set:{changes:staged.changes}}, function (err, doc) {
		if(err){ 
			console.log('(error changing decisions on item) '+err); 
			changeDecisionPromise.reject();
		} else {
			//success
			io.emit('decisionChange',staged);
			changeDecisionPromise.resolve();
		}
	});

	return changeDecisionPromise.promise;
} 

	

//DICTIONARIES --------------------------------

app.get('/api/getDbInfo', function (req,res){
	res.send(dbInfo);
});


//SOCKETS --------------------------------

io.on('connection', function(socket){
  console.log('a user connected');
});


function isEmpty(obj) {
  return Object.keys(obj).length === 0;
}

function generateUID() {
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
      return v.toString(16);
  });
}

function generateKey() {
  return 'xxxxxxxxxxxx-4xxxyxxxxxx99xx-xxxxx00xxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
      return v.toString(16);
  });
}

http.listen(80);
