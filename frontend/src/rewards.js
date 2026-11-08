import {Coffee,ShoppingBag,Ticket,Utensils,Gift} from 'lucide-react';
export const rewards=[
 ['tims5','Tim Hortons','$5 Tims card','Gift cards',500,80,'https://help.timhortons.ca/hc/en-ca/articles/35670326825243-What-is-the-Tims-Gift-Card'],
 ['taste','Matter of Taste','Coffee break','Cafes',250,65,'https://matteroftaste.ca/'],
 ['pyrus','Cafe Pyrus','$5 toward lunch','Restaurants',450,70,'https://www.cafepyrus.com/home'],
 ['princess','Princess Cafe','Lunch & a little wander','Restaurants',600,75,'https://www.princesscafe.ca/'],
 ['seven','Seven Shores','Cafe credit','Cafes',350,70,'https://www.sevenshores.ca/'],
 ['tiger','Smile Tiger','Your next coffee','Cafes',300,70,'https://smiletigercoffee.com/pages/frontpage'],
 ['grt','Grand River Transit','$5 EasyGO credit','Transit',500,75,'https://www.grt.ca/fares-and-payment'],
 ['tims10','Tim Hortons','$10 Tims card','Gift cards',1000,85,'https://help.timhortons.ca/hc/en-ca/articles/35670326825243-What-is-the-Tims-Gift-Card'],
 ['tims25','Tim Hortons','$25 Tims card','Gift cards',2500,95,'https://help.timhortons.ca/hc/en-ca/articles/35670326825243-What-is-the-Tims-Gift-Card'],
 ['local','Local shops','$10 neighbourhood voucher','Stores',1000,80,null],
 ['bike','Bike shop credit','Tune-up fund','Stores',1500,90,null],
 ['grtpass','Grand River Transit','Transit pass fund','Transit',2000,90,'https://www.grt.ca/fares-and-payment'],
].map(([id,place,name,category,cost,minEco,url],i)=>({id,place,name,category,cost,minEco,url,icon:category==='Cafes'?Coffee:category==='Restaurants'?Utensils:category==='Transit'?Ticket:category==='Stores'?ShoppingBag:Gift,color:['peach','lime','mint'][i%3]}));
