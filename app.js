
const dsteem = require('dsteem')
const fs     = require('fs')
const config = JSON.parse(fs.readFileSync('config.json'))
var   nodes  = config.nodes
const chalk  = require('chalk')

const blacklist = config.blacklist
nodes.filter((x) => blacklist.indexOf(x) == -1)

const steemtrxfinder      = require('steemtrxfinder')
const sm_pub              = 'STM7yk3tav5BFEyppNzHhKaXsMTPw8xYX1B1gWXq6bvtT34uVUKbQ'
var mongoUtil             = require('./database')
const sbt_url             = 'https://steembottracker.net'
const axios               = require('axios')
const utils               = dsteem.cryptoUtils

var response 
var bidbots

var clients      = []
var pendingVotes = [] 

var vote_sellers = []
var ignore_list  = []
var corrupted    = []

var postURL      = ''

nodes.forEach((node) => {
	clients.push(new dsteem.Client('https://' + node))
})
function wait (seconds) {
	return new Promise((resolve, reject) => {
		setTimeout(() => {resolve()}, seconds * 1000)
	})
}
function timeout (seconds, mode, address, vote) {
	return new Promise((resolve, reject) => {
		setTimeout(() => {
			if (mode == 'compute') {
				return reject(vote)
			} else if (mode == 'rpc_node') {
				return reject(address)
			}
			
		}, seconds * 1000)
	})
}
function reflect(promise){
    return promise.then(function(v){ return {v:v, status: "fulfilled" }},
                        function(e){ return {e:e, status: "rejected" }});
}
function loadClients () {
	return new Promise(async (resolve, reject) => {
		var promises = []
		var bad_clients = []
		for (let i = 0; i < clients.length; i++) {
			let client = clients[i]
			console.log(client.address)
			promises.push(reflect(Promise.race([client.database.call('get_account_history', ['smartsteem', -1, 50]), timeout(3, 'rpc_node', client.address)]))) 
		}
		let result = await Promise.all(promises)
		bad_clients = result.filter((x) => x.status == 'rejected').map((x) => x.e)
		clients = clients.filter((x) => bad_clients.indexOf(x.address) == -1)
		resolve()
	})
}


async function start (postURL) {

	mongoUtil.connectDB(async (err) => {
		if (err) throw err

		const db           = mongoUtil.getDB()
		const dbase        = db.db('steemium')
		const smartsteem   = dbase.collection('smartsteem')

		var author   = postURL.substring(postURL.lastIndexOf('@') + 1, postURL.lastIndexOf('/'))
		var permlink = postURL.substr(postURL.lastIndexOf('/') + 1)
		var campaign

		try {
			campaign = await campaigns.find({'postURL': {$regex : permlink }}).toArray()
			let ts = Date.parse(campaign[0].ts)
			console.log('campaign found')
			postURL = campaign[0].postURL
		} catch(e) {
			console.log('not a steemium campaign')
		}

		await loadClients(5)

		console.log('Number of rpc node connections: ' + clients.length)
		let registry = await smartsteem.find({'get_account_history': {$exists: true}}).toArray()

		if (!registry[0]) {
			let lastVoteSellers = await fetchLastVoteSellers()
			await smartsteem.insertOne(
				{'get_account_history': lastVoteSellers, createdDate: new Date(), lastUpdate: new Date()}
			)
			votesellers = lastVoteSellers
		} else {
			votesellers = registry[0].get_account_history
		}
		// refresh get account history every X time

		response      = await axios.get(sbt_url + '/bid_bots')
		bidbots       = response.data
		bidbots.map((x)   => ignore_list.push(x.name))
		ignore_list.push(...['tipu', 'ocdb'])		

		query_ignore      = await smartsteem.find({$and:[{account: {$exists:true}}, {postURL: {$regex : permlink }}, {ignore: true}]}).toArray()
		query_votesellers = await smartsteem.find({$and:[{account: {$exists:true}}, {postURL: {$regex : permlink }}, {ignore: false}, {$or: [{ mb: { $exists:false } }, { mb: false } ]}]}).toArray()
		query_corrupted   = await smartsteem.find({$and:[{account: {$exists:true}}, {postURL: {$regex : permlink }}, {mb: true}]}).toArray()
		vote_sellers.push(...query_votesellers.map((x) => x.account))
		ignore_list.push(...query_ignore.map((x) => x.account))
		corrupted.push(...query_corrupted.map((x) => x.account))
		console.log('number of registered votesellers => ' + vote_sellers.length)
		console.log('number of ignored accounts => ' + ignore_list.length)
		console.log('number of corrupted signatures => ' + corrupted.length)
		// let random_node = getRandomInt(clients.length)
		clients[0].database.call('get_content', [author, permlink])
		.then(async(result) => {
			console.log('content loaded')
			let votes = result.active_votes
			if (votes.length == 0) return start(postURL)
			//////////////////////////////////////////////////
			////////// MAIN LOOP PROCESS       //////////////
			////////////////////////////////////////////////
			await votesLoop(votes, false)
			while (pendingVotes.length > 0) {
				console.log(pendingVotes)
				query_ignore      = await smartsteem.find({$and:[{account: {$exists:true}}, {postURL: {$regex : permlink }}, {ignore: true}]}).toArray()
				query_votesellers = await smartsteem.find({$and:[{account: {$exists:true}}, {postURL: {$regex : permlink }}, {ignore: false}, {$or: [{ mb: { $exists:false } }, { mb: false } ]}]}).toArray()
				query_corrupted   = await smartsteem.find({$and:[{account: {$exists:true}}, {postURL: {$regex : permlink }}, {mb: true}]}).toArray()
				vote_sellers.push(...query_votesellers.map((x) => x.account))
				ignore_list.push(...query_ignore.map((x) => x.account))
				corrupted.push(...query_corrupted.map((x) => x.account))
				await votesLoop(pendingVotes, true)
			}
			await getVoteValue(postURL)
		})

		function fetchHistoricalPrices(postURL) {
			return new Promise(async (resolve, reject) => {
				let campaign = await campaigns.find({postURL: postURL}).toArray()
				try { 
					let prices = campaign[0].prices
					return resolve(prices)
				}catch(e) {
					return reject(e)
				}
			})
		}
	})
}

async function votesLoop (votes, rerun) {
	var promises = []
	for (let i = 0; i < votes.length; i++) {
		let vote     = votes[i]
		let voter    = vote.voter
// 				var pending  = []
		console.log(i + ' / ' + (votes.length - 1) + ' ' + chalk.bold(voter))
		if (vote_sellers.indexOf(voter) > -1) {
			try {
				console.log(voter + ' is already registered as SM voteseller')
				// pending.push({ account: vote.voter, vote: vote, ignore: false, postURL: postURL, prices: prices})
				// console.log(chalk.green('succesfully added ' + voter))
				continue
			}catch(e) {
				if (e.code == 11000) {
					console.log(voter + ' is duplicated')
					continue
				} else {
					console.log(e)
					console.log(chalk.red('breaking the loop...'))
					break
				}
			}
		}
		if (ignore_list.indexOf(voter) > -1) {
			console.log(voter + ' is already registered in the ignore list')
			continue
		}

		if (corrupted.indexOf(voter) > -1) {
			console.log(voter + ' is already registered in the corrupted list')
			continue
		}
		//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
		///// The main reason you dont worry about 'Promise.all' triggering at the first rejection -even if there are still pending promises, ////
		///// is the fact that you set a defined max tolerance for timeout (rejection) and that make use of a reflection abstraction that       //
		///// avoids rejections, that way, you have better control over the asynchronous processes    	     									//
		//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
		promises.push(reflect(Promise.race([compute(clients[promises.length], vote), timeout(7, 'compute', clients[promises.length].address, vote)])))

		console.log('using ' + clients[promises.length - 1].address + ' for ' + voter)
		if (promises.length == clients.length) {
			// await wait(5)
			console.log('clients = ' + clients.length)
			console.log(chalk.yellow('reached ' + promises.length + ' promises..waiting'))
			let results = await Promise.all(promises)
			let failed_promises = results.filter((result) => result.status == 'rejected').map((x) => x.e)
			// add to pending votes all failed ones
			pendingVotes.push(...failed_promises)
			// in case we are re-running from pendingVotes, update the list removing the resolved
			let successful_promises = results.filter((result) => result.status == 'fulfilled').map((x) => x.v)
			if (rerun) {
				pendingVotes.filter((x) => {successful_promises.indexOf(x) == -1})
			}
			console.log('number of pending votes = ' + pendingVotes.length)
			console.log('all promises have resolved/rejected, continueing..')
			promises = []
		}
	}
	// if (pending.length == 0) return console.log(chalk.bgGreen.bold('voteLoop function finished, no pending votes'))
	// try { 
	// 	await smartsteem.insertMany(pending, {ordered: false})
	// 	console.log('bulkInsert all good')
	// } catch(e) {
	// 	console.log(chalk.red('bulkInsert error at end of loop'))
	// 	console.log(e)
	// }
}


async function fetchLastVoteSellers () {
	return new Promise((resolve, reject) => {
		var votesellers = []
		clients[0].database.call('get_account_history', ['smartsteem', -1, 5000])
		.then((res) => {
			res.forEach((el) => {
				let trans = el[1]
				let op = trans.op
				if (op[0] == 'transfer' && op[1].memo.startsWith("#")) {
					votesellers.push(op[1].to)
				}
			})
			let uniq = [...new Set(votesellers)]
			return resolve(uniq)
		})
	})
}
// you could store ignored accounts per permlink

function getRandomInt(max) {
  return Math.floor(Math.random() * Math.floor(max));
}

function findVotePseudoTrx (client, vote) {
	return new Promise(async (resolve, reject) => {
		let  permlink = postURL.substr(postURL.lastIndexOf('/') + 1)
		let voter     = vote.voter
		let history   = []
		let match     = null
		var interval  = 0
		while (!match) {
			try {
				history = await client.database.call('get_account_history', [voter, -1 - interval, 1500 + interval])
			} catch(e){
				console.log(e)
				console.log(client.address + ' error at get_account_history  ' + client.address)
				return reject(vote)
			}
			
			match = history.find((x) => x[1].op[0] == 'vote' && x[1].op[1].permlink == permlink)
			interval += 1500
			await wait(0.5)
			// if (interval > 5000) return reject()
		}
		if (interval > 0) console.log(vote.voter + ' findVotePseudoTrx resolved with interval = ' + interval)
		return resolve(match)
	})
}

function compute (client, vote, prices) {
	return new Promise(async(resolve, reject) => {
		let voter = vote.voter
		let pseudo_trx
		try {
			pseudo_trx = await findVotePseudoTrx(client, vote)
		} catch(e) {
			console.log(e)
			return reject(e)
		}
		let trx 
		try {
			trx = await steemtrxfinder.findVoteTrx(client, pseudo_trx)
		} catch(e) {
			console.log(chalk.red('error at steemtrxfinder'))
			console.log(e)
			return reject(vote)
		}
		let digest = utils.transactionDigest(trx)

		let signature
		let pub = ''
		for (let i = 0; i < trx.signatures.length; i++) { 
			let _signature = trx.signatures[i]
			try { 
				signature = dsteem.Signature.fromString(_signature)
				pub = signature.recover(digest).toString()
			} catch(e) {
				console.log(trx)
				console.log(e)
				if (voter !== trx.operations[0][1].voter) return console.log(chalk.red('trx op voter from "steemtrxfinder" result does not match current voter'))
				console.log(chalk.red(voter + ': cannot extract pubkey from origin trx'))
				// console.log(trx)
				if (i == (trx.signatures.length - 1)) {
					// console.log(chalk.bgRed.bold(client.address))
					// console.log(e)
					// console.log(trx)
					// console.log(trx.operations[0][1])
					console.log(vote)
					smartsteem.insertOne({ account: vote.voter, vote: vote, ignore: false, postURL: postURL, prices: prices, mb: true })
					return reject(new Error('cannot extract pubkey'))
				}
			}
		}
		if (pub == sm_pub) {
			// find account SP

			console.log(chalk.green('BINGO smartmarket voter found! - ' + voter))
			smartsteem.insertOne({ account: vote.voter, vote: vote, ignore: false, postURL: postURL, prices: prices	 })
			return resolve(vote)
		} else {
			console.log(chalk.green(voter + ' added to ignore list'))
			smartsteem.insertOne({ account: vote.voter, ignore: true, postURL: postURL })
			return resolve(vote)
		}
	})
}



module.exports = {
	start: start
}




