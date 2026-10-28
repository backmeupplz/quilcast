# python3 scripts/shots/pick.py <network file> <feed> [hash prefix ...]
# Picks the casts a recorded feed shows, in this order, so the store shots show real casts that read well in every
# language rather than whatever was on top that minute. <feed> is part of the request it came from: /feed/trending is
# the signed-out home feed, fid=2210 a profile's casts. Without hashes it lists the feed's casts.
import base64, json, sys

netfile, feed, picks = sys.argv[1], sys.argv[2], sys.argv[3:]
net = json.load(open(netfile))
key = next(k for k in net if feed in k and '/feed/' in k)
body = json.loads(base64.b64decode(net[key]['body']))
if not picks:
    for c in body['casts']:
        embeds = ' '.join(e.get('url', 'cast')[:50] for e in c.get('embeds', []))
        print(c['hash'][:10], c['author']['username'], repr(c['text'][:70]), embeds)
    sys.exit()
body['casts'] = [next(c for c in body['casts'] if c['hash'].startswith(p)) for p in picks]
net[key]['body'] = base64.b64encode(json.dumps(body).encode()).decode()
json.dump(net, open(netfile, 'w'))
print(f'{key} shows {len(picks)} casts: ' + ', '.join(c['author']['username'] for c in body['casts']))
